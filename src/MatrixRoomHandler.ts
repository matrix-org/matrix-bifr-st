import { Bridge, MatrixRoom, RemoteRoom, MatrixUser, Intent} from "matrix-appservice-bridge";
import { PurpleInstance, PurpleProtocol } from "./purple/PurpleInstance";
import { IPurpleInstance } from "./purple/IPurpleInstance";
import { MROOM_TYPE_IM, MROOM_TYPE_GROUP } from "./StoreTypes";
import { IReceivedImMsg, IChatInvite, IRecievedChatMsg } from "./purple/PurpleEvents";
import * as request from "request-promise-native";
import { ProfileSync } from "./ProfileSync";
import { Util } from "./Util";
import { Account } from "node-purple";
import { ProtoHacks } from "./ProtoHacks";

const log = require("matrix-appservice-bridge").Logging.get("MatrixRoomHandler");

/**
 * Handles creation and handling of rooms.
 */
export class MatrixRoomHandler {
    private bridge: Bridge;
    constructor(private purple: IPurpleInstance, private profileSync: ProfileSync, private config: any) {
        purple.on("received-im-msg", this.handleIncomingIM.bind(this));
        purple.on("received-chat-msg", this.handleIncomingChatMsg.bind(this));
        purple.on("chat-invite", this.handleChatInvite.bind(this));
    }

    /**
     * Set the bridge for us to use. This must be called after MatrixEventHandler
     * has been created.
     * @return [description]
     */
    public setBridge(bridge: Bridge) {
        this.bridge = bridge;
    }

    public onAliasQuery(request: any, context: any) {
        log.debug(`onAliasQuery:`, request);
    }

    public onAliasQueried(request: any, context: any) {
        log.debug(`onAliasQueried:`, request);
    }

    private async getMatrixUserForAccount(account: Account): Promise<MatrixUser|null> {
        const matrixUsers = await this.bridge.getUserStore().getMatrixUsersFromRemoteId(
            Util.createRemoteId(account.protocol_id, account.username)
        );
        if (matrixUsers == null || matrixUsers.length == 0) {
            log.error("Could not find an account for the incoming IM. Either the account is not assigned to a matrix user, or we have hit a bug.");
            return null;
        }
        if (matrixUsers.length > 1){
            log.error(`Have multiple matrix users assigned to ${account.username}. Bailing`);
            return null;
        }
        return matrixUsers[0];
    }

    private async createOrGetIMRoom(data: IReceivedImMsg, matrixUser: MatrixUser, intent: Intent) {
        console.log(data);
        // Check to see if we have a room for this IM.
        const roomStore = this.bridge.getRoomStore();
        let remoteData = {
            matrixUser: matrixUser.getId(),
            protocol_id: data.account.protocol_id,
            recipient: data.sender,
        };
        // For some reason the following function wites to remoteData, so recreate it later
        const remoteEntries = await roomStore.getEntriesByRemoteRoomData(remoteData);
        let roomId;
        if (remoteEntries == null || remoteEntries.length == 0) {
            remoteData = {
                matrixUser: matrixUser.getId(),
                protocol_id: data.account.protocol_id,
                recipient: data.sender,
            };
            log.info(`Couldn't find room for IM ${matrixUser.getId()} <-> ${data.sender}. Creating a new one`);
            const res = await intent.createRoom({
                createAsClient: true,
                options: {
                    is_direct: true,
                    name: data.sender,
                    visibility: "private",
                    invite: [matrixUser.getId()]
                }
            });
            roomId = res.room_id;
            log.debug("Created room with id ", roomId);
            const remoteId = Buffer.from(
                `${matrixUser.getId()}:${data.account.protocol_id}:${data.sender}`
            ).toString("base64");
            log.debug("Storing remote room ", remoteId, " with data ", remoteData);
            const mxRoom = new MatrixRoom(roomId);
            mxRoom.set("type", MROOM_TYPE_IM);
            await roomStore.setMatrixRoom(mxRoom);
            await roomStore.linkRooms(mxRoom, new RemoteRoom(
                remoteId,
            remoteData));
            // Room doesn't exist yet, create it.
        } else {
            if (remoteEntries.length > 1) {
                log.error(`Have multiple matrix rooms assigned for IM ${matrixUser.getId()} <-> ${data.sender}. Bailing`);
                return;
            }
            roomId = remoteEntries[0].matrix.getId();
        }
        return roomId;
    }

    private async createOrGetGroupChatRoom(data: IRecievedChatMsg|IChatInvite, intent: Intent, matrixUser?: MatrixUser) {
        // Check to see if we have a room for this IM.
        const roomStore = this.bridge.getRoomStore();
        let room_name;
        if (("room_name" in data)) {
            room_name = ProtoHacks.getRoomNameForInvite(data);
        } else {
            room_name = data.conv.name;
        }
        // XXX: This is potentially fragile as we are basically doing a lookup via
        // a set of properties we hope will be unique.
        const props = ("room_name" in data) ? Object.assign({}, data.join_properties) : undefined;
        if (props) {
            delete props.password;
        }
        // Delete a password, if given because we don't need to lookup/store it·
        let remoteData = {
            protocol_id: data.account.protocol_id,
            room_name,
        };
        // For some reason the following function wites to remoteData, so recreate it later
        const remoteEntries = await roomStore.getEntriesByRemoteRoomData(remoteData);
        let roomId;
        if (remoteEntries == null || remoteEntries.length == 0) {
            remoteData = {
                protocol_id: data.account.protocol_id,
                room_name,
                properties: props,
            } as any;
            log.info(`Couldn't find room for ${room_name}. Creating a new one`);
            let invite: string[] = [];
            if (matrixUser) {
                invite.push(matrixUser.getId());
            }
            const res = await intent.createRoom({
                createAsClient: false,
                options: {
                    name: room_name,
                    visibility: "private",
                    invite,
                }
            });
            roomId = res.room_id;
            log.debug("Created room with id ", roomId);
            const remoteId = Buffer.from(
                `${data.account.protocol_id}:${room_name}`
            ).toString("base64");
            log.debug("Storing remote room ", remoteId, " with data ", remoteData);
            const mxRoom = new MatrixRoom(roomId);
            mxRoom.set("type", MROOM_TYPE_GROUP);
            await roomStore.setMatrixRoom(mxRoom);
            await roomStore.linkRooms(mxRoom, new RemoteRoom(
                remoteId,
            remoteData));
            // Room doesn't exist yet, create it.
        } else {
            if (remoteEntries.length > 1) {
                log.error(`Have multiple matrix rooms assigned for chat. Bailing`);
                return;
            }
            roomId = remoteEntries[0].matrix.getId();
        }
        return roomId;
    }

    private async handleIncomingIM(data: IReceivedImMsg) {
        log.debug(`Handling incoming IM from ${data.sender}`);
        // First, find out who the message was intended for.
        const matrixUser = await this.getMatrixUserForAccount(data.account);
        if (matrixUser === null) {
            return;
        }
        const protocol = this.purple.getProtocol(data.account.protocol_id);
        if (!protocol) {
            log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
            return;
        }
        log.debug(`Message intended for ${matrixUser.getId()}`);
        const senderMatrixUser = Util.getMxIdForProtocol(
            protocol,
            data.sender,
            this.config.bridge.domain,
            this.config.bridge.userPrefix
        );
        const intent = this.bridge.getIntent(senderMatrixUser.getId());
        log.debug("Identified ghost user as", senderMatrixUser.getId());
        let roomId;
        try {
            roomId = await this.createOrGetIMRoom(data, matrixUser, intent);
        } catch (e) {
            log.error(`Failed to get/create room for this IM: ${e}`);
            return;
        }
        // Update the user if needed.
        const account = await this.purple.getAccount(data.account.username, data.account.protocol_id)!;
        await this.profileSync.updateProfile(protocol, data.sender,
            account
        );

        log.debug(`Sending message to ${roomId} as ${senderMatrixUser.getId()}`);
        await intent.sendMessage(roomId, {
            msgtype: "m.text",
            body: data.message,
        });
    }

    private async handleIncomingChatMsg(data: IRecievedChatMsg) {
        log.debug(`Handling incoming chat from ${data.sender} (${data.conv.name})`);
        // If multiple of our users are in this room, it may dupe up here.
        const protocol = this.purple.getProtocol(data.account.protocol_id);
        if (!protocol) {
            log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
            return;
        }
        const senderMatrixUser = Util.getMxIdForProtocol(
            protocol,
            data.sender,
            this.config.bridge.domain,
            this.config.bridge.userPrefix
        );
        const intent = this.bridge.getIntent(senderMatrixUser.getId());
        let roomId;
        try {
            // Note that this will not invite anyone.
            roomId = await this.createOrGetGroupChatRoom(data, intent);
        } catch (e) {
            log.error(`Failed to get/create room for this IM: ${e}`);
            return;
        }
        await intent.sendMessage(roomId, {
            msgtype: "m.text",
            body: data.message,
        });
    }

    private async handleChatInvite(data: IChatInvite) {
        log.debug(`Handling invite to chat for ${data.room_name}`, data);
        // First, find out who the message was intended for.
        const matrixUser = await this.getMatrixUserForAccount(data.account);
        if (matrixUser === null) {
            return;
        }
        const protocol = this.purple.getProtocol(data.account.protocol_id);
        if (!protocol) {
            log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
            return;
        }
        const senderMatrixUser = Util.getMxIdForProtocol(
            protocol,
            data.sender,
            this.config.bridge.domain,
            this.config.bridge.userPrefix
        );
        const intent = this.bridge.getIntent(senderMatrixUser.getId());
        let roomId;
        // XXX: These chats are shared across multiple matrix users potentially,
        // so remember to invite newbloods.
        try {
            // This will create the room and invite the user.
            roomId = await this.createOrGetGroupChatRoom(data, intent, matrixUser);
        } catch (e) {
            log.error(`Failed to get/create room for this IM: ${e}`);
            return;
        }
        if (data.message) {
            await intent.sendMessage(roomId, {
                msgtype: "m.text",
                body: data.message,
            });
        }
    }
}
