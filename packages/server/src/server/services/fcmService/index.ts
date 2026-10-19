import * as admin from "firebase-admin";
import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { RulesFile } from "firebase-admin/lib/security-rules/security-rules";
import { App } from "firebase-admin/app";
import axios from "axios";
import { isEmpty } from "@server/helpers/utils";
import { ScheduledService } from "@server/lib/ScheduledService";
import { Loggable } from "@server/lib/logging/Loggable";
import { AsyncSingleton } from "@server/lib/decorators/AsyncSingletonDecorator";
import { AsyncRetryer } from "@server/lib/decorators/AsyncRetryerDecorator";
import { ProxyServices } from "@server/databases/server/constants";
import { boundFcmDataPayload, FCM_MAX_DATA_BYTES } from "./FcmPayload";

const AppName = "BlueBubbles";

enum DbType {
    UNKNOWN = "unknown",
    FIRESTORE = "firestore",
    REALTIME = "realtime"
}

/**
 * This services manages the connection to the connected
 * Google FCM server. This is used to handle/manage notifications
 */
export class FCMService extends Loggable {
    tag = "FCMService";

    static getApp(): admin.app.App {
        try {
            return admin.app(AppName);
        } catch (ex: any) {
            return null;
        }
    }

    lastRestart = 0;

    lastProjectId: string = null;

    lastProjectNumber: string = null;

    dbType = DbType.UNKNOWN;

    hasInitialized = false;

    serverConfig: any = null;

    clientConfig: any = null;

    addressUpdateService: ScheduledService = null;

    @AsyncSingleton("FCMService.initAddressUpdateLoop")
    private async initAddressUpdateLoop() {
        // If the service is already running, don't start another one
        if (this.addressUpdateService != null && !this.addressUpdateService.stopped) return;

        // If the proxy service is lan-url or dynamic-dns, we don't need to start this service
        const proxyService = Server().repo.getConfig("proxy_service") as string;
        if (proxyService === ProxyServices.LanURL || proxyService === ProxyServices.DynamicDNS) return;

        this.addressUpdateService = new ScheduledService(() => {
            // If the app has been deleted (service stopped), clear the interval
            if (!FCMService.getApp()) {
                return this.addressUpdateService.stop();
            }

            this.log.debug(`Attempting to update server URL (20 minute loop)...`);
            this.setServerUrl(true);
        }, 600000 * 2);
    }

    @AsyncSingleton("FCMService.start")
    @AsyncRetryer({
        name: "FCMService.start",
        maxTries: 6,
        retryDelay: 5000,
        retryCondition: (data: boolean) => data == null
    })
    async start({
        initializeOnly = false
    }: {
        initializeOnly?: boolean;
    } = {}): Promise<boolean> {
        // If we have already initialized the app, don't re-initialize
        const app = FCMService.getApp();
        if (app) return true;

        this.hasInitialized = false;

        // Load in the last restart date
        const lastRestart = Server().repo.getConfig("last_fcm_restart");
        this.lastRestart = !lastRestart ? 0 : (lastRestart as number);

        const hasConfigs = this.loadConfigs();
        if (!hasConfigs) {
            this.log.info("FCM is not fully configured. Skipping...");
            return false;
        }

        this.dbType = this.clientConfig.project_info?.firebase_url ? DbType.REALTIME : DbType.FIRESTORE;
        this.log.info(`Initializing new FCM App (${this.dbType})`);

        // Initialize the app
        admin.initializeApp(
            {
                credential: admin.credential.cert(this.serverConfig),
                databaseURL: this.clientConfig.project_info.firebase_url,
                projectId: this.serverConfig.project_id
            },
            AppName
        );

        try {
            // Validate the project exists
            await this.validateProject(this.serverConfig.project_id);
        } catch (ex) {
            // Catch an error and stop the service
            await FCMService.stop();
            throw ex;
        }

        this.hasInitialized = true;

        if (!initializeOnly) {
            if (this.dbType === DbType.REALTIME) {
                await this.setRealtimeRules();
            }

            this.setServerUrl().catch(ex => {
                this.log.warn(`Failed to set server URL after initializing FCM App. Error: ${ex?.message}`);
            });

            this.listen().catch(ex => {
                this.log.warn(`Failed to listen for DB changes after initializing FCM App. Error: ${ex?.message}`);
            });
        }

        // this.initAddressUpdateLoop();

        return true;
    }

    loadConfigs(): boolean {
        this.serverConfig = FileSystem.getFCMServer();
        this.clientConfig = FileSystem.getFCMClient();
        return this.hasConfigs();
    }

    hasConfigs(): boolean {
        return !!this.serverConfig && !!this.clientConfig;
    }

    static async setFirestoreRulesForApp(app: App): Promise<void> {
        const source: RulesFile = {
            name: "firestore.rules",
            content:
                "rules_version = '2';\n" +
                "service cloud.firestore {\n" +
                "  match /databases/{database}/documents {\n" +
                "    match /server/config {\n" +
                "      allow read;\n" +
                "    }\n" +
                "\n" +
                "    match /server/commands {\n" +
                "      allow write;\n" +
                "    }\n" +
                "  }\n" +
                "}"
        };

        const rules = admin.securityRules(app);
        let shouldRefresh = true;

        try {
            // Get the current ruleset and only set the rules if they are different
            const currentRuleset = await rules.getFirestoreRuleset();
            const firestoreRules = currentRuleset?.source?.find(rule => rule.name === source.name);
            if (firestoreRules?.content === source.content) shouldRefresh = false;
        } catch (ex: any) {
            // Do nothing
        }

        if (!shouldRefresh) return;
        const ruleset = await rules.createRuleset(source);
        await rules.releaseFirestoreRuleset(ruleset.name);
    }

    async setRealtimeRules() {
        // Set the rules
        const source = JSON.stringify(
            {
                rules: {
                    ".read": true,
                    ".write": false,
                    config: {
                        nextRestart: {
                            ".write": true
                        }
                    }
                }
            },
            null,
            4
        );

        const db = FCMService.getApp().database();

        // Set read rules
        await db.setRules(source);
    }

    async clearConfig() {
        this.lastRestart = 0;
        this.lastProjectId = null;
        this.lastProjectNumber = null;

        // Remove all registered apps
        await Promise.all(admin.apps.map(app => app.delete()));
    }

    /**
     * Checks to see if the URL has changed since the last time we updated it
     *
     * @returns The new URL if it has changed, null otherwise
     */
    shouldUpdateUrl(): boolean {
        // Make sure we have configs in the first place
        if (!this.hasConfigs()) return null;

        // Make sure that information has changed
        return (
            this.lastProjectId !== this.serverConfig.project_id ||
            this.lastProjectNumber !== this.clientConfig?.project_info?.project_number
        );
    }

    /**
     * Sets the server URL within firebase
     *
     * @param serverUrl The new server URL
     */
    @AsyncSingleton("FCMService.setServerUrl")
    @AsyncRetryer({
        name: "FCMService.setServerUrl",
        maxTries: 12,
        retryDelay: 5000,
        onSuccess: (_data: any) => true
    })
    async setServerUrl(force = false): Promise<void> {
        // Make sure we should be setting the URL
        const shouldUpdate = this.shouldUpdateUrl();
        if (!shouldUpdate && !force) return;

        // Make sure we have a server address
        const serverUrl = Server().repo.getConfig("server_address") as string;
        if (isEmpty(serverUrl)) return;

        // Make sure that if we haven't initialized, we do so
        if (!this.hasInitialized && !(await this.start())) return;

        this.log.debug(`Attempting to write server URL to database...`);
        await this.saveUrlToDb(serverUrl);
        this.log.info("Successfully updated server address");

        this.lastProjectId = this.serverConfig?.project_id;
        this.lastProjectNumber = this.clientConfig?.project_info?.project_number;
    }

    private async saveUrlToDb(serverUrl: string) {
        if (this.dbType === DbType.FIRESTORE) {
            await this.setServerUrlFirestore(serverUrl);
        } else if (this.dbType === DbType.REALTIME) {
            await this.setServerUrlRealtime(serverUrl);
        }
    }

    /**
     * Set the server URL in the Firestore.
     * If the current value is already the latest URL,
     * do not update it.
     *
     * @param serverUrl The new server URL
     */
    async setServerUrlFirestore(serverUrl: string): Promise<void> {
        const db = FCMService.getApp().firestore();
        const currentValue = (await db.collection("server").doc("config").get())?.data()?.serverUrl;
        if (currentValue !== serverUrl) {
            await db.collection("server").doc("config").set({ serverUrl }, { merge: true });
        }
    }

    /**
     * Set the server URL in the Realtime DB.
     * If the current value is already the latest URL,
     * do not update it.
     *
     * @param serverUrl The new server URL
     */
    async setServerUrlRealtime(serverUrl: string): Promise<void> {
        const db = FCMService.getApp().database();

        // Update the config
        const config = db.ref("config");
        config.once("value", data => {
            const currentValue = data.val();
            if (currentValue !== serverUrl) {
                config.update({ serverUrl });
            }
        });
    }

    async validateProject(projectId: string): Promise<void> {
        const app = FCMService.getApp();
        const auth = await app.options.credential.getAccessToken();
        const headers: Record<string, string> = {
            Authorization: `Bearer ${auth.access_token}`,
            Accept: "application/json"
        };

        try {
            await axios.request({
                method: "GET",
                url: `https://firebase.googleapis.com/v1beta1/projects/${projectId}`,
                headers
            });
        } catch (ex: any) {
            const errorResponse = ex?.response.data;
            if (errorResponse?.error?.message) {
                // If the project has been deleted, we should unload the FCM configs.
                // And stop the service.
                if (errorResponse.error.message.includes("has been deleted")) {
                    this.log.info(`Firebase Project ${projectId} has been deleted. Unloading FCM configs...`);
                    FileSystem.saveFCMClient(null);
                    FileSystem.saveFCMServer(null);
                }

                throw new Error(`Firebase Project Error: ${errorResponse.error.message}`);
            } else {
                throw new Error(`Firebase Project Error: ${ex?.message ?? String(ex)}`);
            }
        }
    }

    @AsyncSingleton("FCMService.listen")
    async listen() {
        const app = FCMService.getApp();
        if (!app) return;

        this.log.info(`Listening for changes in Firebase (${this.dbType})...`);
        if (this.dbType === DbType.FIRESTORE) {
            await this.listenFirestoreDb();
        } else if (this.dbType === DbType.REALTIME) {
            await this.listenRealtimeDb();
        }
    }

    @AsyncRetryer({
        name: "FCMService.listenFirestoreDb",
        maxTries: 12,
        retryDelay: 5000,
        onSuccess: (_data: any) => true
    })
    private async listenFirestoreDb() {
        const app = FCMService.getApp();
        const db = app.firestore();

        const startListening = () =>
            new Promise<void>((resolve, reject) => {
                db.collection("server")
                    .doc("commands")
                    .onSnapshot(
                        (snapshot: admin.firestore.DocumentSnapshot) => {
                            this.nextRestartHandler(snapshot.data()?.nextRestart);
                            resolve();
                        },
                        async (error: any) => {
                            reject(error);
                        }
                    );
            });

        await startListening();
        this.log.info("Successfully listening for DB changes");
    }

    @AsyncRetryer({
        name: "FCMService.listenRealtimeDb",
        maxTries: 12,
        retryDelay: 5000,
        onSuccess: (_data: any) => true
    })
    private async listenRealtimeDb() {
        const app = FCMService.getApp();
        const db = app.database();

        const startListening = () =>
            new Promise<void>((resolve, reject) => {
                db.ref("config")
                    .child("nextRestart")
                    .on(
                        "value",
                        async (snapshot: admin.database.DataSnapshot) => {
                            this.nextRestartHandler(snapshot.val());
                            resolve();
                        },
                        (error: any) => {
                            reject(error);
                        }
                    );
            });

        await startListening();
        this.log.info("Successfully listening for DB changes");
    }

    private async nextRestartHandler(value: any) {
        if (!value) return;

        if (typeof value === "string") {
            value = parseInt(value);
        }

        try {
            if (value > this.lastRestart) {
                this.log.info("Received request to restart via FCM! Restarting...");

                // Update the last restart values
                await Server().repo.setConfig("last_fcm_restart", value);
                this.lastRestart = value;

                // Do a restart
                await Server().relaunch();
            }
        } catch (ex: any) {
            this.log.error(`Failed to restart after FCM request!\n${ex}`);
        }
    }

    /**
     * Sends a notification to all connected devices
     *
     * @param devices Devices to send the notification to
     * @param data The data to send
     */
    async sendNotification(
        devices: string[],
        data: any,
        priority: "normal" | "high" = "normal"
    ): Promise<admin.messaging.BatchResponse> {
        try {
            if (!this.hasInitialized && !(await this.start())) return null;

            const boundedData = boundFcmDataPayload(data);
            if (!boundedData) {
                this.log.warn(
                    "Skipping FCM notification because its data envelope is invalid or cannot fit within " +
                        `${FCM_MAX_DATA_BYTES} bytes.`
                );
                return { responses: [], successCount: 0, failureCount: 0 };
            }

            // Build out the notification message. The Admin SDK expands this
            // multicast payload into one message per token without changing data.
            const payload: admin.messaging.MulticastMessage = {
                data: boundedData,
                tokens: devices,
                android: {
                    priority,
                    // 24 hour TTL (in milliseconds).
                    // The Firebase library takes milliseconds, even though the docs say seconds
                    ttl: 24 * 60 * 60 * 1000
                }
            };

            this.log.debug(`Sending FCM notification (Priority: ${priority}) to ${devices.length} device(s)`);
            const response = await FCMService.getApp().messaging().sendEachForMulticast(payload);
            if (response.failureCount > 0) {
                response.responses.forEach(resp => {
                    if (!resp.success && resp.error) {
                        const code = resp.error?.code;
                        const msg = resp.error?.message;
                        if (code === "messaging/payload-size-limit-exceeded") {
                            // Do not log payload contents: they may contain message/chat identifiers or credentials.
                            this.log.warn("Could not send Firebase Notification due to payload exceeding size limits!");
                        } else if (code !== "messaging/registration-token-not-registered") {
                            // Ignore token not registered errors
                            this.log.error(`Firebase returned the following error (Code: ${code}): ${msg}`);

                            if (resp.error?.stack) {
                                this.log.debug(`Firebase Stacktrace: ${resp.error.stack}`);
                            }
                        }
                    }
                });
            }

            return response;
        } catch (ex: any) {
            this.log.debug(`Failed to send notification! ${ex.message}`);
        }

        return { responses: [], successCount: 0, failureCount: 0 };
    }

    async restart() {
        await FCMService.stop();
        await this.start();
    }

    static async stop() {
        const app = FCMService.getApp();
        if (app) await app.delete();
    }
}
