import { MatrixRoom, RemoteRoom, MatrixUser, Bridge } from "matrix-appservice-bridge";
import { IRemoteRoomData, IRemoteGroupData, IRoomEntry, MROOM_TYPES } from "./Types";
import { BifrostProtocol } from "../bifrost/Protocol";
import { IAccountMinimal } from "../bifrost/Events";
import { BifrostRemoteUser } from "./BifrostRemoteUser";
import { IConfigDatastore } from "../Config";
import { NeDBStore } from "./NeDBStore";
import { PgDataStore } from "./postgres/PgDatastore";

export async function initiateStore(config: IConfigDatastore, bridge: Bridge): Promise<IStore> {
    if (config.engine === "nedb") {
        return new NeDBStore(bridge);
    } else if (config.engine === "postgres") {
        const pg = new PgDataStore(config);
        await pg.ensureSchema();
        return pg;
    }
    throw Error("Database engine not supported");
}

export interface IStore {

    getMatrixUser(id: string): Promise<MatrixUser|null>;

    getMatrixUserForAccount(account: IAccountMinimal): Promise<MatrixUser|null>;

    setMatrixUser(matrix: MatrixUser): Promise<void>;

    getRemoteUserBySender(sender: string, protocol: BifrostProtocol): Promise<BifrostRemoteUser|null>;

    getAccountsForMatrixUser(userId: string, protocolId: string): Promise<BifrostRemoteUser[]>;

    getRemoteUsersFromMxId(userId: string): Promise<BifrostRemoteUser[]>;

    getRoomByRemoteData(remoteData: IRemoteRoomData|IRemoteGroupData): Promise<IRoomEntry|null>;

    getIMRoom(matrixUserId: string, protocolId: string, remoteUserId: string): Promise<IRoomEntry|null>;

    getUsernameMxidForProtocol(protocol: BifrostProtocol): Promise<{[mxid: string]: string}>;

    getRoomsOfType(type: MROOM_TYPES): Promise<IRoomEntry[]>;

    storeGhost(userId: string, protocol: BifrostProtocol, username: string)
        : Promise<{remote: BifrostRemoteUser, matrix: MatrixUser}>;
    storeAccount(userId: string, protocol: BifrostProtocol, username: string, extraData?: any): Promise<void>;
    removeRoomByRoomId(matrixId: string): Promise<void>;

    getRoomEntryByMatrixId(roomId: string): Promise<IRoomEntry|null>;

    storeRoom(matrixId: string, type: MROOM_TYPES, remoteId: string, remoteData: IRemoteRoomData)
    : Promise<IRoomEntry>;

    integrityCheck(canWrite: boolean): Promise<void>;
}
