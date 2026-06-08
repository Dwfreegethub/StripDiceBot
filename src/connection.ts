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
    // Connect and login to BC
    public connect(): Promise<void> {
        return new Promise((resolve, reject) => {

            this.socket.on("connect", () => {
                log("Socket connected. Logging in...");
                this.socket.emit("AccountLogin", {
                    AccountName: secrets.username,
                    Password: secrets.password,
                });
            });

            // Login response
            this.socket.on("LoginResponse", (data: any) => {
                if (typeof data === "string") {
                    logError(`Login failed: ${data}`);
                    reject(new Error(data));
                    return;
                }
                this.playerNumber = data.MemberNumber;
                this.connected = true;
                log(`Logged in successfully! Member #${this.playerNumber}`);

                // Send appearance data back so we show as fully online on friend lists
                this.socket.emit("AccountUpdate", {
					 AssetFamily: "Female3DCG"
                
                });
                log("AssetFamily set.");

                resolve();
            });

            // Room create response
            this.socket.on("ChatRoomCreateResponse", (data: any) => {
                if (data === "ChatRoomCreated") {
                    log("Room created successfully!");
                } else {
                    logError(`Room creation failed: ${JSON.stringify(data)}`);
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

    // Create a new room
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

    // Send a chat message to the room
    public sendChat(message: string): void {
        this.socket.emit("ChatRoomChat", {
            Type: "Chat",
            Content: message,
            Dictionary: [],
        });
    }

    // Whisper to a specific player
    public whisper(targetNumber: number, message: string): void {
        this.socket.emit("ChatRoomChat", {
            Type: "Whisper",
            Content: message,
            Target: targetNumber,
            Dictionary: [],
        });
    }

    // Listen to all incoming events (for debugging)
    public listenAll(): void {
        const events = [
            "ChatRoomSync",
            "ChatRoomSyncMemberJoin",
            "ChatRoomSyncMemberLeave",
            "ChatRoomMessage",
            "ChatRoomSyncItem",
            "ServerInfo",
            "AccountBeep",
        ];
        events.forEach(event => {
            this.socket.on(event, (data: any) => {
                logEvent(event, data);
            });
        });
    }

    // Handle incoming chat messages
    public onMessage(handler: (data: any) => void): void {
        this.socket.on("ChatRoomMessage", handler);
    }

    // Handle room sync (initial room state)
    public onRoomSync(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSync", handler);
    }

    // Handle item changes (clothing removal detection)
    public onItemChange(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncItem", handler);
    }

    // Handle member joining the room
    public onMemberJoin(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncMemberJoin", handler);
    }

    // Handle member leaving the room
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