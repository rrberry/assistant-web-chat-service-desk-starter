/**
 * (C) Copyright IBM Corp. 2020.
 *
 * Licensed under the MIT License (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * https://opensource.org/licenses/MIT
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 *
 */

/**
 * Copy and paste this file into a new folder to get started.
 */

import { ErrorType } from '../../types/errors';
import { ConnectToAgentItem, MessageInput, MessageOutput, MessageRequest, MessageResponse } from '../../types/message';
import { User } from '../../types/profiles';
import { ServiceDesk, ServiceDeskFactoryParameters, ServiceDeskStateFromWAC } from '../../types/serviceDesk';
import { AgentProfile, ServiceDeskCallback } from '../../types/serviceDeskCallback';
import {
  ChatBody,
  ChatResponse,
  GenesysBodyType,
  GenesysConstants,
  GenesysMemberState,
  GenesysMetadataType,
  LOG_PREFIX,
  MessageEvent,
} from './genesysTypes';
import { setup } from './purecloudSetup';
import { messages } from './stockMessages';

/**
 * Indicates whether your chat deployment requires authentication.
 * If true, this code will attempt to fetch a memberAuthToken from the authentication server pointed to
 * by AUTH_SERVER_BASE_URL in '../../purecloudSetup.ts' and use it when creating the chat.
 */
const WIDGET_REQUIRES_AUTHENTICATION = false;

/**
 * Indicates whether you've built out functionality to support API calls that require OAuth authentication.
 * These should be supported at the same server used for authenticated chat. Currently this flag is only
 * used for getAgentAvailability().
 */
const AUTHENTICATED_CALLS_ENABLED = false;

/**
 * This class returns startChat, endChat, sendMessageToAgent, userTyping and userReadMessages to be exposed to web chat
 * through src/buildEntry.ts.
 */
class GenesysServiceDesk implements ServiceDesk {
  agentProfile: AgentProfile;
  callback: ServiceDeskCallback;
  user: User;

  /**
   * Stores the member ID of the agent in the guest chat conversation. Used to check if
   * messages and actions are originating from the agent.
   */
  agent: User;

  /**
   * an instance of the PureCloud Web Chat API; API functions can be called on this.
   */
  webChatApi: any;

  /**
   * Information about the guest chat returned by the chat API's postWebchatGuestConversations() function.
   */
  chatInfo: ChatResponse;

  /**
   * A flag indicating if the first agent in the conversation has joined; used to differentiate between
   * that scenario and an agent transfer (calling the appropriate callbacks in each case).
   */
  initialAgentJoined: boolean;

  /**
   * The ID of the user in the PureCloud guest chat conversation; used in any functions performed on
   * behalf of the user, such as posting user messages to the agent.
   */
  conversationUserId: string;

  constructor(parameters: ServiceDeskFactoryParameters) {
    this.callback = parameters.callback;
    this.initialAgentJoined = false;
  }
  /**
   * Instructs the service desk to start a new chat. This should be called immediately after the service desk
   * instance has been created. It will make the appropriate calls to the service desk and begin communicating back
   * to the calling code using the callback produce to the instance. This may only be called once per instance.
   *
   * @param connectMessage The original server message response that caused the connection to an agent. It will
   * contain specific information to send to the service desk as part of the connection. This can includes things
   * like a message to display to a human agent.
   * @returns Returns a Promise that resolves when the service desk has successfully started a new chat. This does
   * not necessarily mean that an agent has joined the conversation or has read any messages sent by the user.
   */
  async startChat(connectMessage: MessageResponse): Promise<void> {
    // append SDK script in browser
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = GenesysConstants.SCRIPT_SOURCE;

      script.onerror = (error: any) => reject(error);
      script.onload = () => resolve();

      document.head.append(script);
    });

    const platformClient = (window as any).require(GenesysConstants.PLATFORM_CLIENT);
    this.webChatApi = new platformClient.WebChatApi();

    /**
     * We need to update the service desk state every time a new chat
     * session is started, in case the userID has changed.
     */
    this.updateState({
      userID: connectMessage.context.global.system.user_id,
    } as ServiceDeskStateFromWAC);

    const createChatBody: ChatBody = {
      organizationId: setup.ORGANIZATION_ID,
      deploymentId: setup.DEPLOYMENT_ID,
      routingTarget: {
        targetType: 'QUEUE',
        targetAddress: setup.QUEUE_TARGET,
      },
      memberInfo: {
        displayName: this.user.id,
      },
    };

    // create chat

    try {
      // fetch and set user auth if required
      if (WIDGET_REQUIRES_AUTHENTICATION) {
        /**
         * In the future, this call should be protected using some security measure
         * based on user info
         */
        const userAuth = await fetch(`${setup.AUTH_SERVER_BASE_URL}/jwt`, {
          method: 'POST',
          redirect: 'follow', // This can be set to ("error" | "follow" | "manual")
        });

        createChatBody.memberAuthToken = await userAuth.text();
      }
    } catch (error) {
      console.error('Cannot complete user authentication.');

      this.callback.setErrorStatus({
        logInfo: error,
        type: ErrorType.CONNECTING,
      });

      return Promise.reject();
    }

    try {
      this.chatInfo = await this.webChatApi.postWebchatGuestConversations(createChatBody);
    } catch (error) {
      console.error('Cannot open chat.');

      this.callback.setErrorStatus({
        logInfo: error,
        type: ErrorType.CONNECTING,
      });

      return Promise.reject();
    }
    this.conversationUserId = this.chatInfo.member.id;

    /**
     * this must be set at the start of the conversation to enable use of the
     * other guest chat client API functions
     */
    platformClient.ApiClient.instance.setJwt(this.chatInfo.jwt);

    // open web socket
    try {
      await this.openWebSocket(this.chatInfo.eventStreamUri);
    } catch (error) {
      console.error('An error occurred while creating the websocket');

      this.callback.setErrorStatus({
        logInfo: error,
        type: ErrorType.CONNECTING,
      });

      return Promise.reject();
    }

    // send initial connect_to_agent message from WA
    const connect2Agent = connectMessage.output.generic[0] as ConnectToAgentItem;

    const initialRequest: MessageRequest = {
      input: {
        text: this.buildSummaryMessageToAgent(connect2Agent),
        source: this.user,
      } as MessageInput,
    };

    try {
      await this.sendMessageToAgent(initialRequest, connectMessage.id);
    } catch (error) {
      console.error(error);
      return Promise.reject();
    }

    return Promise.resolve();
  }

  async openWebSocket(uri: string): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const socket = new WebSocket(uri);

        socket.addEventListener('open', () => {
          console.log(`${LOG_PREFIX} WebSocket connected`);
          return resolve(socket); // websocket only returned once it's open!
        });

        socket.addEventListener('message', (event) => this.handleMessage(event));

        console.log(`${LOG_PREFIX} chat started`); // prefix your console messages
      } catch (error) {
        reject(error);
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async handleMessage(event: any): Promise<void> {
    let message;

    try {
      message = JSON.parse(event.data) as MessageEvent;
    } catch (error) {
      console.error('An error occurred while parsing the message: ', error);
      return Promise.reject();
    }

    // Chat message
    if (message.metadata) {
      switch (message.metadata.type) {
        // Handle message from member
        case GenesysMetadataType.MESSAGE: {
          const sender = message.eventBody.sender.id;

          switch (message.eventBody.bodyType) {
            case GenesysBodyType.MEMBER_JOIN: {
              break;
            }

            case GenesysBodyType.MEMBER_LEAVE: {
              if (this.agent?.id === sender) this.callback.agentLeftChat();
              break;
            }

            case GenesysBodyType.STD: {
              if (this.agent?.id === sender) {
                // agent wrote it
                this.callback.agentTyping(false);

                this.callback.sendMessageToUser(this.formatMessageResponse(message), this.agent.id);
              }
              break;
            }
            default:
              console.log('Unknown message type');
          }
          break;
        }

        case GenesysMetadataType.MEMBER_CHANGE: {
          const member = message.eventBody.member.id;
          // Handle member state change
          switch (message.eventBody.member.state) {
            case GenesysMemberState.DISCONNECTED: {
              if (this.agent?.id === member) {
                // delete this.agent;
                console.log(`${LOG_PREFIX} agent left`);

                /**
                 * used to distinguish between agent transfer and agent ending chat.
                 * if user (Cade) is still connected when the agent disconnects, then
                 * the chat has not ended -> Cade is being transferred to another agent
                 */
                const userStillConnected = await this.userConnected();
                console.log(`${LOG_PREFIX} user still connected: ${userStillConnected}`);
                if (!userStillConnected) this.callback.agentEndedChat();
              }

              break;
            }

            case GenesysMemberState.ALERTING: {
              // either this alert is to the first agent to join, or we're transferring to a new agent
              if (this.initialAgentJoined) this.callback.beginTransferToAnotherAgent();

              this.agent = {
                id: member,
              };

              console.log(`${LOG_PREFIX} awaiting agent`);

              break;
            }

            case GenesysMemberState.CONNECTED: {
              if (this.agent?.id === member) {
                console.log(`${LOG_PREFIX} new agent joined`);
                await this.populateAgent();

                if (!this.initialAgentJoined) this.initialAgentJoined = true;
              } else if (this.conversationUserId !== member) {
                /**
                 * If no agents have answered a call, the chat is connected to a dummy agent.
                 * In that case, getAgentAvailability() sets the current wait time for web chat.
                 */
                try {
                  if (AUTHENTICATED_CALLS_ENABLED) await this.getAgentAvailability();
                } catch (error) {
                  console.error(error); // don't need to stop everything for an error here
                }
              }

              break;
            }

            default:
              break;
          }

          break;
        }

        case GenesysMetadataType.TYPING_IND: {
          const sender = message.eventBody.sender.id;
          if (sender === this.conversationUserId) {
            await this.userTyping(true);
          } else {
            this.callback.agentTyping(true);

            /**
             * Per Genesys docs: https://developer.mypurecloud.com/api/webchat/guestchat.html#_span_style__text_transform__none___typing_indicator__event__span_
             * The typing indicator should generally be honored for about
             * four seconds or until a message is received from that participant,
             * whichever comes first.
             */
            setTimeout(() => this.callback.agentTyping(false), 4000);
          }

          break;
        }
        default: {
          console.log(`${LOG_PREFIX} Unknown message type: ${message.metadata.type}`);
        }
      }
    }

    return Promise.resolve();
  }

  /**
   * fetch and fill in agent info
   */
  async populateAgent(): Promise<void> {
    let agentInfo;

    try {
      agentInfo = await this.webChatApi.getWebchatGuestConversationMember(this.chatInfo.id, this.agent.id);
    } catch (error) {
      /**
       * If getting agent information fails, we will fall back
       * to default values. Agent is still connected.
       */
      console.error('Error retrieving agent information: ', error);
    }

    this.callback.agentJoined({
      id: this.agent.id,
      nickname: agentInfo.displayName || 'Agent',
      profile_picture_url: agentInfo.avatarImageUrl,
    });

    return Promise.resolve();
  }

  // check if the user is still connected
  async userConnected(): Promise<boolean> {
    const user = await this.webChatApi.getWebchatGuestConversationMember(this.chatInfo.id, this.conversationUserId);

    return Promise.resolve(user.state === GenesysMemberState.CONNECTED);
  }

  /**
   * Tells the service desk to terminate the chat.
   *
   * @returns Returns a Promise that resolves when the service desk has successfully handled the call.
   */
  async endChat(): Promise<void> {
    const userConnected = await this.userConnected();

    return new Promise((resolve, reject) => {
      if (!userConnected) return resolve(); // conversation already deleted

      try {
        this.webChatApi.deleteWebchatGuestConversationMember(this.chatInfo.id, this.conversationUserId);
        return resolve();
      } catch (error) {
        console.error('Error ending chat: ', error);
        return reject();
      }
    });
  }

  /**
   * Sends a message to the agent in the service desk.
   *
   * @param message The message from the user.
   * @param messageID The unique ID of the message assigned by the widget.
   * @returns Returns a Promise that resolves when the service desk has successfully handled the call.
   */
  async sendMessageToAgent(message: MessageRequest, messageID: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.webChatApi.postWebchatGuestConversationMemberMessages(
          this.chatInfo.id, // conversation ID
          this.conversationUserId,
          {
            body: message.input.text,
            bodyType: GenesysBodyType.STD,
          },
        );
      } catch (error) {
        console.error('Encountered an error sending message to agent: ', error);
        return reject();
      }
      return resolve();
    });
  }

  /**
   * Informs the service desk of a change in the state of the web chat that is relevant to the service desks. These
   * values may change at any time.
   *
   * @param state The current values of pieces of state from the main chat.
   */
  updateState(state: ServiceDeskStateFromWAC): void {
    this.user = { id: state.userID };
  }

  /**
   * Tells the service desk if a user has started or stopped typing.
   *
   * This functionality is not currently implemented in the web chat widget.
   *
   * @param isTyping If true, indicates that the user is typing. False indicates the user has stopped typing.
   * @returns Returns a Promise that resolves when the service desk has successfully handled the call.
   */
  async userTyping(isTyping: boolean): Promise<void> {
    // Genesys API does not include functions for setting and removing typing indicator
    return new Promise((resolve, reject) => {
      try {
        this.webChatApi.postWebchatGuestConversationMemberTyping(this.chatInfo.id, this.conversationUserId);
        return resolve();
      } catch (error) {
        console.error(error);
        return reject();
      }
    });
  }

  formatMessageResponse(msg: MessageEvent): MessageResponse {
    return {
      id: msg.eventBody.id,
      thread_id: 'agent',
      output: {
        generic: [
          {
            response_type: 'text',
            text: msg.eventBody.body,
          },
        ],
      } as MessageOutput,
    } as MessageResponse;
  }

  buildSummaryMessageToAgent(item: ConnectToAgentItem): string {
    if (item.message_to_human_agent) return `${item.message_to_human_agent}\n${messages.SUMMARY(item.topic)}`;
    return `${messages.PREFIX_MESSAGE_TO_AGENT}\n${messages.SUMMARY(item.topic)}\n${messages.POSTFIX_MESSAGE_TO_AGENT}`;
  }

  async getAgentAvailability(): Promise<any> {
    let availabilityRequest;
    let agentAvailable: boolean;

    try {
      availabilityRequest = await fetch(`${setup.AUTH_SERVER_BASE_URL}/availability`, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue: setup.QUEUE_TARGET }),
      });
    } catch (error) {
      return Promise.reject(error);
    }

    const availability = await availabilityRequest.json();

    // ETA is always > 0, this branch is never reached
    if (availability.estimatedWaitTime < 0) {
      this.callback.setErrorStatus({
        logInfo: 'No agents are available to handle your request',
        type: ErrorType.CONNECTING,
      });
      agentAvailable = false;
    } else {
      this.callback.updateAgentAvailability({
        estimated_wait_time: availability.estimatedWaitTime,
        position_in_queue: availability.positionInQueue,
      });

      agentAvailable = true;
    }
    return Promise.resolve(agentAvailable);
  }
}

export { GenesysServiceDesk };
