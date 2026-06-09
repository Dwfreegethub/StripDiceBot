import { io, Socket } from "socket.io-client";
import { log, logError, logEvent } from "./logger";
import { secrets } from "./secrets";

const BC_SERVER = "https://bondage-club-server.herokuapp.com/";

export class BCConnection {
    private socket: Socket;
    private playerNumber: number = 0;
    private connected: boolean = false;

    constructor() {
        this.socket = io(BC_SERVER, {
            transports: ["websocket"],
            extraHeaders: {
                "Origin": "https://bondageprojects.elementfx.com"
            }
        });
    }

    public connect(): Promise<void> {
        return new Promise((resolve, reject) => {

            this.socket.on("connect", () => {
                log("Socket connected. Logging in...");
                this.socket.emit("AccountLogin", {
                    AccountName: secrets.username,
                    Password: secrets.password,
                });
            });

            this.socket.on("LoginResponse", (data: any) => {
                if (typeof data === "string") {
                    logError(`Login failed: ${data}`);
                    reject(new Error(data));
                    return;
                }
                this.playerNumber = data.MemberNumber;
                this.connected = true;
                log(`Logged in successfully! Member #${this.playerNumber}`);

                this.socket.emit("AccountUpdate", {
                    Inventory:      data.Inventory      ?? [],
                    OnlineSettings: data.OnlineSettings ?? {}
                });

                this.socket.emit("AccountUpdate", {
                    Game: data.Game ?? {}
                });

                this.socket.emit("AccountUpdate", {
                    AssetFamily: "Female3DCG"
                });

                log("Initialization sequence sent.");
                resolve();
            });

            this.socket.on("ChatRoomCreateResponse", (data: any) => {
                if (data === "ChatRoomCreated") {
                    log("Room created successfully!");
                } else if (data === "RoomAlreadyExist") {
                    log("Room already exists, joining instead...");
                    this.socket.emit("ChatRoomJoin", {
                        Name: secrets.roomName
                    });
                } else {
                    logError(`Room creation failed: ${JSON.stringify(data)}`);
                }
            });

            this.socket.on("ChatRoomJoinResponse", (data: any) => {
                if (data === "JoinedRoom" || data === "ok") {
                    log("Joined existing room successfully!");
                } else {
                    logError(`Failed to join room: ${JSON.stringify(data)}`);
                }
            });

            this.socket.on("connect_error", (err: any) => {
                logError(`Connection error: ${err.message}`);
                reject(err);
            });

            this.socket.on("disconnect", (reason: string) => {
                log(`Disconnected: ${reason}`);
                this.connected = false;
            });

        });
    }

    public joinRoom(): void {
        log(`Creating room: ${secrets.roomName}`);
        this.socket.emit("ChatRoomCreate", {
            Name: secrets.roomName,
            Description: "A Strip Dice game room - type !join to play!",
            Background: "NightClub",
            Space: "X",
            Game: "",
            Admin: [this.playerNumber, 208543],
            Ban: [],
            Limit: 10,
            BlockCategory: [],
            Language: "EN",
            Visibility: ["Admin"],
            Access: ["All"],
        });
    }

    public sendChat(message: string): void {
        this.socket.emit("ChatRoomChat", {
            Type: "Chat",
            Content: message,
            Dictionary: [],
        });
    }

    public whisper(targetNumber: number, message: string): void {
        this.socket.emit("ChatRoomChat", {
            Type: "Whisper",
            Content: message,
            Target: targetNumber,
            Dictionary: [],
        });
    }

    public applyItem(targetNumber: number, group: string, name: string, color: string | string[], property: any): void {
        this.socket.emit("ChatRoomCharacterItemUpdate", {
            Target: targetNumber,
            Group: group,
            Name: name,
            Color: color,
            Difficulty: 2,
            Property: property
        });
    }

    public removeItem(targetNumber: number, group: string): void {
        this.socket.emit("ChatRoomCharacterItemUpdate", {
            Target: targetNumber,
            Group: group,
            Name: null,
            Color: null,
            Difficulty: 0,
            Property: {}
        });
    }

    public listenAll(): void {
        const events = [
            "ChatRoomSync",
            "ChatRoomSyncMemberJoin",
            "ChatRoomSyncMemberLeave",
            "ChatRoomMessage",
            "ChatRoomSyncItem",
            "ChatRoomSyncCharacter",
            "ChatRoomSyncExpression",
            "ServerInfo",
            "AccountBeep",
        ];
        events.forEach(event => {
            this.socket.on(event, (data: any) => {
                logEvent(event, data);
            });
        });
    }

    public onMessage(handler: (data: any) => void): void {
        this.socket.on("ChatRoomMessage", handler);
    }

    public onRoomSync(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSync", handler);
    }

    public onItemChange(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncItem", handler);
    }

    public onMemberJoin(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncMemberJoin", handler);
    }

    public onMemberLeave(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncMemberLeave", handler);
    }

    public getMemberNumber(): number {
        return this.playerNumber;
    }

    public isConnected(): boolean {
        return this.connected;
    }
}