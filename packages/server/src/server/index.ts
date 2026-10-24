/* eslint-disable class-methods-use-this */
// Dependency Imports
import { app, BrowserWindow, nativeTheme, systemPreferences, dialog, MessageBoxOptions } from "electron";
import ServerLog, { LogLevel } from "electron-log";
import process from "process";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import macosVersion from "macos-version";
import { getAuthStatus } from "node-mac-permissions";

// Configuration/Filesytem Imports
import { FileSystem } from "@server/fileSystem";

// Database Imports
import { ServerRepository, ServerConfigChange } from "@server/databases/server";
import { MessageRepository } from "@server/databases/imessage";
import { FindMyRepository } from "@server/databases/findmy";
import { Message } from "@server/databases/imessage/entity/Message";

// Service Imports
import {
    FCMService,
    CaffeinateService,
    NgrokService,
    NetworkService,
    QueueService,
    IPCService,
    UpdateService,
    CloudflareService,
    WebhookService,
    ScheduledMessagesService,
    OauthService,
    ZrokService
} from "@server/services";
import { EventCache } from "@server/eventCache";
import { runTerminalScript, openSystemPreferences, startMessages } from "@server/api/apple/scripts";

import { ActionHandler } from "./api/apple/actions";
import { insertChatParticipants, isEmpty, isNotEmpty, waitMs } from "./helpers/utils";
import { isMinBigSur, isMinCatalina, isMinHighSierra, isMinMojave, isMinMonterey, isMinSierra } from "./env";
import { Proxy } from "./services/proxyServices/proxy";
import { PrivateApiService } from "./api/privateApi/PrivateApiService";
import { OutgoingMessageManager } from "./managers/outgoingMessageManager";
import { requestContactPermission } from "./utils/PermissionUtils";
import { AlertsInterface } from "./api/interfaces/alertsInterface";
import { MessageSerializer } from "./api/serializers/MessageSerializer";
import {
    CHAT_READ_STATUS_CHANGED,
    GROUP_ICON_CHANGED,
    GROUP_ICON_REMOVED,
    GROUP_NAME_CHANGE,
    MESSAGE_UPDATED,
    NEW_MESSAGE,
    NEW_SERVER,
    PARTICIPANT_ADDED,
    PARTICIPANT_LEFT,
    PARTICIPANT_REMOVED
} from "./events";
import { Chat } from "./databases/imessage/entity/Chat";
import { HttpService } from "./api/http";
import { Alert } from "./databases/server/entity";
import { getStartDelay } from "./utils/ConfigUtils";
import { FindMyFriendsCache } from "./api/lib/findmy/FindMyFriendsCache";
import { ScheduledService } from "./lib/ScheduledService";
import { getLogger } from "./lib/logging/Loggable";
import { IMessageListener } from "./databases/imessage/listeners/IMessageListener";
import { ChatUpdatePoller } from "./databases/imessage/pollers/ChatChangePoller";
import { IMessageCache } from "./databases/imessage/pollers";
import { MessagePoller } from "./databases/imessage/pollers/MessagePoller";
import { obfuscatedHandle } from "./utils/StringUtils";
import { AutoStartMethods } from "./databases/server/constants";
import { MacOsInterface } from "./api/interfaces/macosInterface";
import { ZrokManager } from "./managers/zrokManager";
import { resolveFcmPriority } from "./services/fcmService/FcmPriority";

const findProcess = require("find-process");

const osVersion = macosVersion();

// Set the log format
const logFormat = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}][{level}]{text}";
ServerLog.transports.console.format = logFormat;
ServerLog.transports.file.format = logFormat;

// Patch in the original package path so we don't use @bluebubbles/server
ServerLog.transports.file.resolvePath = () =>
    path.join(os.homedir(), "Library", "Logs", "bluebubbles-server", "main.log");

/**
 * Create a singleton for the server so that it can be referenced everywhere.
 * Plus, we only want one instance of it running at all times.
 */
let server: BlueBubblesServer = null;
export const Server = (args: Record<string, any> = {}, win: BrowserWindow = null) => {
    // If we already have a server, update the window (if not null) and return
    // the same instance
    if (server) {
        if (win) server.window = win;
        return server;
    }

    // Only use args when instantiating a new server object
    server = new BlueBubblesServer(args, win);
    return server;
};

/**
 * Main entry point for the back-end server
 * This will handle all services and helpers that get spun
 * up when running the application.
 */
class BlueBubblesServer extends EventEmitter {
    logger = getLogger("BlueBubblesServer");

    args: Record<string, any>;

    window: BrowserWindow;

    uiLoaded: boolean;

    repo: ServerRepository;

    iMessageRepo: MessageRepository;

    findMyRepo: FindMyRepository;

    httpService: HttpService;

    privateApi: PrivateApiService;

    fcm: FCMService;

    networkChecker: NetworkService;

    caffeinate: CaffeinateService;

    updater: UpdateService;

    scheduledMessages: ScheduledMessagesService;

    messageManager: OutgoingMessageManager;

    queue: QueueService;

    proxyServices: Proxy[];

    webhookService: WebhookService;

    oauthService: OauthService;

    actionHandler: ActionHandler;

    eventCache: EventCache;

    findMyCache: FindMyFriendsCache;

    iMessageListener: IMessageListener;

    hasSetup: boolean;

    hasStarted: boolean;

    notificationCount: number;

    isRestarting: boolean;

    isStopping: boolean;

    lastConnection: number;

    region: string | null;

    typingCache: string[];

    get hasDiskAccess(): boolean {
        // As long as we've tried to initialize the DB, we know if we do/do not have access.
        const dbInit: boolean | null = this.iMessageRepo?.db?.isInitialized;
        if (dbInit != null) return dbInit;

        // If we've never initialized the DB, and just want to detect if we have access,
        // we can check the permissions using node-mac-permissions. However, default to true,
        // if the macOS version is under Mojave.
        let status = true;
        if (isMinMojave) {
            const authStatus = getAuthStatus("full-disk-access");
            if (authStatus === "authorized") {
                status = true;
            } else {
                this.logger.debug(`FullDiskAccess Permission Status: ${authStatus}`);
            }
        }

        return status;
    }

    get hasAccessibilityAccess(): boolean {
        return systemPreferences.isTrustedAccessibilityClient(false) === true;
    }

    get computerIdentifier(): string {
        return `${os.userInfo().username}@${os.hostname()}`;
    }

    /**
     * Constructor to just initialize everything to null pretty much
     *
     * @param window The browser window associated with the Electron app
     */
    constructor(args: Record<string, any>, window: BrowserWindow) {
        super();

        this.args = args;
        this.window = window;
        this.uiLoaded = false;

        // Databases
        this.repo = null;
        this.iMessageRepo = null;
        this.findMyRepo = null;

        // Other helpers
        this.eventCache = null;
        this.actionHandler = null;

        // Services
        this.httpService = null;
        this.privateApi = null;
        this.fcm = null;
        this.caffeinate = null;
        this.networkChecker = null;
        this.queue = null;
        this.proxyServices = [];
        this.updater = null;
        this.messageManager = null;
        this.webhookService = null;
        this.scheduledMessages = null;
        this.oauthService = null;
        this.iMessageListener = null;

        this.hasSetup = false;
        this.hasStarted = false;
        this.notificationCount = 0;
        this.isRestarting = false;
        this.isStopping = false;

        this.region = null;
        this.typingCache = [];
        this.findMyCache = null;
    }

    emitToUI(event: string, data: any) {
        try {
            if (!this.uiLoaded) return;
            if (this.window && !this.window.webContents.isDestroyed()) {
                this.window.webContents.send(event, data);
            }
        } catch {
            /* Ignore errors here */
        }
    }

    /**
     * Handler for sending logs. This allows us to also route
     * the logs to the main Electron window
     *
     * @param message The message to print
     * @param type The log type
     */
    log(message: any, type?: LogLevel) {
        switch (type) {
            case "error":
                ServerLog.error(message);
                AlertsInterface.create("error", message);
                this.notificationCount += 1;
                break;
            case "debug":
                ServerLog.debug(message);
                break;
            case "warn":
                ServerLog.warn(message);
                AlertsInterface.create("warn", message);
                this.notificationCount += 1;
                break;
            case "info":
            default:
                ServerLog.log(message);
        }

        if (["error"].includes(type)) {
            this.setNotificationCount(this.notificationCount);
        }

        this.emitToUI("new-log", {
            message,
            type: type ?? "log"
        });
    }

    setNotificationCount(count: number) {
        this.notificationCount = count;

        if (this.repo?.getConfig("dock_badge")) {
            app.setBadgeCount(this.notificationCount);
        }
    }

    /**
     * This will load any DB config options set via the CLI args.
     * This will also check to make sure that the values match the type
     * of the config value.
     */
    loadSettingsFromArgs() {
        // This flag is true by default. If it's set to false, all
        // config values will not be stored in teh DB.
        const persist = this.args["persist-config"] ?? true;
        this.loadSettingsFromDict(this.args, persist);
    }

    loadSettingsFromDict(data: Record<string, any>, persist = true) {
        // Iterate through the args and find the matching config.
        for (const [key, value] of Object.entries(data)) {
            // If the key exists in the DB config, set it.
            // Account for if the user uses dashes instead of underscores
            let normalizedKey;
            if (key in this.repo.config) {
                normalizedKey = key;
            } else if (key.replaceAll("-", "_") in this.repo.config) {
                normalizedKey = key.replaceAll("-", "_");
            } else {
                continue;
            }

            // Make sure the value matches the type of the config value
            const configValue = this.repo.config[normalizedKey];
            if (configValue != null && typeof configValue !== typeof value) {
                this.logger.warn(
                    `[ENV] Invalid type for config value "${normalizedKey}"! ` +
                        `Expected ${typeof configValue}, got ${typeof value}`
                );
                continue;
            }

            const shouldLog =
                !normalizedKey.includes("token") &&
                !normalizedKey.includes("key") &&
                !normalizedKey.includes("password") &&
                !normalizedKey.includes("secret");
            if (shouldLog) {
                this.logger.info(`[ENV] Setting config value ${normalizedKey} to ${value} (persist=${persist})`);
            }

            // Set the value
            this.repo.setConfig(normalizedKey, value, persist);
        }
    }

    async initServer(): Promise<void> {
        // If we've already started up, don't do anything
        if (this.hasStarted) return;

        this.logger.info("Performing initial setup...");

        // Get the current macOS theme
        this.getTheme();

        try {
            this.logger.info("Initializing filesystem...");
            FileSystem.setup();
        } catch (ex: any) {
            this.logger.error(`Failed to setup Filesystem! ${ex?.message ?? String(ex)}}`);
        }

        // Initialize and connect to the server database
        await this.initDatabase();

        // Load settings from args
        this.loadSettingsFromArgs();

        this.logger.info("Starting IPC Listeners..");
        IPCService.startIpcListeners();

        // Delay will only occur if your Mac started up within the last 5 minutes
        const startDelay: number = getStartDelay();
        const uptimeSeconds = os.uptime();
        if (startDelay > 0 && uptimeSeconds < 300) {
            this.logger.info(`Delaying server startup by ${startDelay} seconds`);
            await waitMs(startDelay * 1000);
        }

        // Let listeners know the server is ready
        this.emit("ready");

        // Do some pre-flight checks
        // Make sure settings are correct and all things are a go
        await this.preChecks();

        if (!this.isRestarting) {
            await this.initServerComponents();
        }
    }

    async initDatabase(): Promise<void> {
        this.logger.info("Initializing server database...");
        this.repo = new ServerRepository();
        await this.repo.initialize();

        // Handle when something in the config changes
        this.repo.on("config-update", (args: ServerConfigChange) => this.handleConfigUpdate(args));

        try {
            this.logger.info("Connecting to iMessage database...");
            this.iMessageRepo = new MessageRepository();
            await this.iMessageRepo.initialize();
        } catch (ex: any) {
            this.logger.error(ex);

            const dialogOpts: MessageBoxOptions = {
                type: "error",
                buttons: ["Restart", "Open System Preferences", "Ignore"],
                title: "BlueBubbles Error",
                message: "Full-Disk Access Permission Required!",
                detail:
                    `In order to function correctly, BlueBubbles requires full-disk access. ` +
                    `Please enable Full-Disk Access in System Preferences > Security & Privacy.`
            };

            dialog.showMessageBox(this.window, dialogOpts).then(returnValue => {
                if (returnValue.response === 0) {
                    this.relaunch();
                } else if (returnValue.response === 1) {
                    FileSystem.executeAppleScript(openSystemPreferences());
                    app.quit();
                }
            });
        }

        this.logger.info("Initializing FindMy Repository...");
        this.findMyRepo = new FindMyRepository();
    }

    initFcm(): void {
        try {
            this.logger.info("Initializing connection to Google FCM...");
            this.fcm = new FCMService();
        } catch (ex: any) {
            this.logger.error(`Failed to setup Google FCM service! ${ex?.message ?? String(ex)}}`);
        }
    }

    initOauthService(): void {
        try {
            this.logger.info("Initializing OAuth service...");
            this.oauthService = new OauthService();
        } catch (ex: any) {
            this.logger.error(`Failed to setup OAuth service! ${ex?.message ?? String(ex)}}`);
        }
    }

    async initServices(): Promise<void> {
        this.initFcm();

        try {
            this.logger.info("Initializing up sockets...");
            this.httpService = new HttpService();
        } catch (ex: any) {
            this.logger.error(`Failed to setup socket service! ${ex?.message ?? String(ex)}}`);
        }

        this.initOauthService();

        try {
            this.logger.info("Initializing helper service...");
            this.privateApi = new PrivateApiService();
        } catch (ex: any) {
            this.logger.error(`Failed to setup helper service! ${ex?.message ?? String(ex)}}`);
        }

        try {
            this.logger.info("Initializing proxy services...");
            this.proxyServices = [new NgrokService(), new CloudflareService(), new ZrokService()];
        } catch (ex: any) {
            this.logger.error(`Failed to initialize proxy services! ${ex?.message ?? String(ex)}}`);
        }

        try {
            this.logger.info("Initializing Message Manager...");
            this.messageManager = new OutgoingMessageManager();
        } catch (ex: any) {
            this.logger.error(`Failed to start Message Manager service! ${ex?.message ?? String(ex)}}`);
        }

        try {
            this.logger.info("Initializing Webhook Service...");
            this.webhookService = new WebhookService();
        } catch (ex: any) {
            this.logger.error(`Failed to start Webhook service! ${ex?.message ?? String(ex)}}`);
        }

        try {
            this.logger.info("Initializing Scheduled Messages Service...");
            this.scheduledMessages = new ScheduledMessagesService();
        } catch (ex: any) {
            this.logger.error(`Failed to start Scheduled Message service! ${ex?.message ?? String(ex)}}`);
        }
    }

    /**
     * Helper method for starting the message services
     *
     */
    async startServices(): Promise<void> {
        try {
            this.logger.info("Starting HTTP service...");
            this.httpService.initialize();
            this.httpService.start();
        } catch (ex: any) {
            this.logger.error(`Failed to start HTTP service! ${ex?.message ?? String(ex)}}`);
        }

        // Only start the oauth service if the tutorial isn't done
        const tutorialDone = this.repo.getConfig("tutorial_is_done") as boolean;
        const oauthToken = this.args["oauth-token"];
        this.oauthService.initialize();

        // If the user passed an oauth token, use that to setup the project
        if (isNotEmpty(oauthToken)) {
            this.oauthService.authToken = oauthToken;
            await this.oauthService.handleProjectCreation();
        } else if (!tutorialDone) {
            // if there isn't a token, and the tutorial isn't done, start the oauth service
            this.oauthService.start();
        }

        try {
            await this.startProxyServices();
        } catch (ex: any) {
            this.logger.error(`Failed to connect to proxy service! ${ex?.message ?? String(ex)}`);
        }

        try {
            this.logger.info("Starting Scheduled Messages service...");
            await this.scheduledMessages.start();
        } catch (ex: any) {
            this.logger.error(`Failed to start Scheduled Messages service! ${ex?.message ?? String(ex)}}`);
        }

        const privateApiEnabled = this.repo.getConfig("enable_private_api") as boolean;
        const ftPrivateApiEnabled = this.repo.getConfig("enable_ft_private_api") as boolean;
        if (privateApiEnabled || ftPrivateApiEnabled) {
            this.logger.info("Starting Private API Helper listener...");
            this.privateApi.start();
        }

        if (this.hasDiskAccess) {
            this.logger.info("Starting iMessage Database listeners...");
            await this.startChatListeners();
        }

        try {
            this.logger.info("Starting FCM service...");
            await this.fcm.start();
        } catch (ex: any) {
            this.logger.error(`Failed to start FCM service! ${ex?.message ?? String(ex)}}`);
        }
    }

    async stopServices(): Promise<void> {
        this.isStopping = true;
        this.logger.info("Stopping services...");

        try {
            FCMService.stop();
        } catch (ex: any) {
            this.logger.info(`Failed to stop FCM service! ${ex?.message ?? ex}`);
        }

        try {
            this.removeChatListeners();
            this.removeAllListeners();
        } catch (ex: any) {
            this.logger.info(`Failed to stop iMessage database listeners! ${ex?.message ?? ex}`);
        }

        try {
            await this.privateApi?.stop();
        } catch (ex: any) {
            this.logger.info(`Failed to stop Private API Helper service! ${ex?.message ?? ex}`);
        }

        try {
            await this.stopProxyServices();
        } catch (ex: any) {
            this.logger.info(`Failed to stop Proxy services! ${ex?.message ?? ex}`);
        }

        try {
            await this.httpService?.stop();
        } catch (ex: any) {
            this.logger.error(`Failed to stop HTTP service! ${ex?.message ?? ex}`);
        }

        try {
            await this.oauthService?.stop();
        } catch (ex: any) {
            this.logger.error(`Failed to stop OAuth service! ${ex?.message ?? ex}`);
        }

        try {
            this.scheduledMessages?.stop();
        } catch (ex: any) {
            this.logger.error(`Failed to stop Scheduled Messages service! ${ex?.message ?? ex}`);
        }

        this.logger.info("Finished stopping services...");
    }

    async stopServerComponents() {
        this.isStopping = true;
        this.logger.info("Stopping all server components...");

        try {
            if (this.networkChecker) this.networkChecker.stop();
        } catch (ex: any) {
            this.logger.info(`Failed to stop Network Checker service! ${ex?.message ?? ex}`);
        }

        try {
            if (this.caffeinate) this.caffeinate.stop();
        } catch (ex: any) {
            this.logger.info(`Failed to stop Caffeinate service! ${ex?.message ?? ex}`);
        }

        try {
            await this.iMessageRepo?.db?.destroy();
        } catch (ex: any) {
            this.logger.info(`Failed to close iMessage Database connection! ${ex?.message ?? ex}`);
        }

        try {
            if (this.repo?.db?.isInitialized) {
                await this.repo?.db?.destroy();
            }
        } catch (ex: any) {
            this.logger.info(`Failed to close Server Database connection! ${ex?.message ?? ex}`);
        }

        this.logger.info("Finished stopping all server components...");
    }

    /**
     * Officially starts the server. First, runs the setup,
     * then starts all of the services required for the server
     */
    async start(): Promise<void> {
        // Initialize server components (i.e. database, caches, listeners, etc.)
        await this.initServer();
        if (this.isRestarting) return;

        // Initialize the services (FCM, HTTP, Proxy, etc.)
        this.logger.info("Initializing Services...");
        await this.initServices();

        // Start the services
        this.logger.info("Starting Services...");
        await this.startServices();

        // Perform any post-setup tasks/checks
        await this.postChecks();

        // Let everyone know the setup is complete
        this.emit("setup-complete");

        // After setup is complete, start the update checker
        try {
            // Wait 5 seconds before starting the update checker.
            // This is just to not use up too much CPU on startup
            await waitMs(5000);
            this.logger.info("Initializing Update Service..");
            this.updater = new UpdateService(this.window);

            const check = Server().repo.getConfig("check_for_updates") as boolean;
            if (check) {
                this.updater?.start();
                this.updater?.checkForUpdate();
            }
        } catch (ex: any) {
            this.logger.error("There was a problem initializing the update service.");
        }
    }

    /**
     * Performs the initial setup for the server.
     * Mainly, instantiation of a bunch of classes/handlers
     */
    private async initServerComponents(): Promise<void> {
        this.logger.info("Initializing Server Components...");

        // Load notification count
        try {
            this.logger.info("Initializing alert service...");
            const alerts = (await AlertsInterface.find()).filter((item: Alert) => !item.isRead);
            this.notificationCount = alerts.length;
        } catch (ex: any) {
            this.logger.warn("Failed to get initial notification count. Skipping.");
        }

        // Setup lightweight message cache
        this.logger.info("Initializing event cache...");
        this.eventCache = new EventCache();

        this.logger.info("Initializing FindMy Location cache...");
        this.findMyCache = new FindMyFriendsCache();

        try {
            this.logger.info("Initializing caffeinate service...");
            this.caffeinate = new CaffeinateService();
            if (this.repo.getConfig("auto_caffeinate")) {
                this.caffeinate.start();
            }
        } catch (ex: any) {
            this.logger.error(`Failed to setup caffeinate service! ${ex?.message ?? String(ex)}}`);
        }

        try {
            this.logger.info("Initializing queue service...");
            this.queue = new QueueService();
        } catch (ex: any) {
            this.logger.error(`Failed to setup queue service! ${ex?.message ?? String(ex)}}`);
        }

        try {
            this.logger.info("Initializing network service...");
            this.networkChecker = new NetworkService();
            this.networkChecker.on("status-change", async connected => {
                if (connected) {
                    this.logger.info("Re-connected to network!");
                    if (!this.fcm) {
                        this.initFcm();
                    }

                    // Restart the FCM service and the proxy services
                    // after reconnection to a network.
                    this.logger.info("Restarting FCM and Proxy Services...");
                    await this.fcm.start();
                    this.restartProxyServices();
                } else {
                    this.logger.info("Disconnected from network!");
                }
            });

            this.networkChecker.start();
        } catch (ex: any) {
            this.logger.error(`Failed to setup network service! ${ex?.message ?? String(ex)}}`);
        }
    }

    async startProxyServices() {
        this.logger.info("Starting Proxy Services...");
        for (const i of this.proxyServices) {
            await i.start();
        }
    }

    async restartProxyServices() {
        this.logger.info("Restarting Proxy Services...");
        for (const i of this.proxyServices) {
            await i.restart();
        }
    }

    async stopProxyServices() {
        this.logger.info("Stopping Proxy Services...");
        for (const i of this.proxyServices) {
            await i.disconnect();
        }
    }

    private async preChecks(): Promise<void> {
        this.logger.info("Running pre-start checks...");

        // Set the dock icon according to the config
        this.setDockIcon();

        // Don't relaunch if the auto start method is set to launch agent. This will cause a loop.
        const noGpu = Server().repo.getConfig("disable_gpu") ?? false;
        const isLaunchAgent = Server().repo.getConfig("auto_start_method") === AutoStartMethods.LaunchAgent;
        if (noGpu && !this.args["disable-gpu"] && !isLaunchAgent) {
            this.relaunch();
        }

        // Start minimized if enabled
        const startMinimized = Server().repo.getConfig("start_minimized") as boolean;
        if (startMinimized) {
            this.window.minimize();
        }

        // Disable the encryp coms setting if it's enabled.
        // This is a temporary fix until the android client supports it again.
        const encryptComs = Server().repo.getConfig("encrypt_coms") as boolean;
        if (encryptComs) {
            this.logger.info("Disabling encrypt coms setting...");
            Server().repo.setConfig("encrypt_coms", false);
        }

        try {
            // Restart via terminal if configured
            const restartViaTerminal = Server().repo.getConfig("start_via_terminal") as boolean;
            const parentProc = await findProcess("pid", process.ppid);
            const parentName = isNotEmpty(parentProc) ? parentProc[0].name : null;

            // Restart if enabled and the parent process is the app being launched
            if (restartViaTerminal && (!parentProc[0].name || parentName === "launchd")) {
                this.isRestarting = true;
                this.logger.info("Restarting via terminal after post-check (configured)");
                await this.restartViaTerminal();
            }
        } catch (ex: any) {
            this.logger.info(`Failed to restart via terminal!\n${ex}`);
        }

        // Get the current region
        this.region = await FileSystem.getRegion();

        // Log some server metadata
        this.logger.debug(`Server Metadata -> Server Version: v${app.getVersion()}`);
        this.logger.debug(`Server Metadata -> macOS Version: v${osVersion}`);
        this.logger.debug(`Server Metadata -> Local Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
        this.logger.debug(`Server Metadata -> Time Synchronization: ${(await FileSystem.getTimeSync()) ?? "N/A"}`);
        this.logger.debug(`Server Metadata -> Detected Region: ${this.region}`);

        if (!this.region) {
            this.logger.debug("No region detected, defaulting to US...");
            this.region = "US";
        }

        // If the user is on el capitan, we need to force cloudflare
        const proxyService = this.repo.getConfig("proxy_service") as string;
        if (!isMinSierra && proxyService === "Ngrok") {
            this.logger.info("El Capitan detected. Forcing Cloudflare Proxy");
            await this.repo.setConfig("proxy_service", "Cloudflare");
        }

        // If the user is using tcp, force back to http
        const ngrokProtocol = this.repo.getConfig("ngrok_protocol") as string;
        if (ngrokProtocol === "tcp") {
            this.logger.info("TCP protocol detected. Forcing HTTP protocol");
            await this.repo.setConfig("ngrok_protocol", "http");
        }

        this.logger.info("Checking Permissions...");

        // Log if we dont have accessibility access
        if (this.hasAccessibilityAccess) {
            this.logger.info("Accessibility permissions are enabled");
        } else {
            this.logger.debug("Accessibility permissions are required for certain actions!");
        }

        // Log if we dont have accessibility access
        if (this.hasDiskAccess) {
            this.logger.info("Full-disk access permissions are enabled");
        } else {
            this.logger.error("Full-disk access permissions are required!");
        }

        // Make sure Messages is running
        try {
            await FileSystem.startMessages();
        } catch (ex: any) {
            this.logger.warn(`Unable to start Messages.app! CLI Error: ${ex?.message ?? String(ex)}`);
        }

        const msgCheckInterval = new ScheduledService(async () => {
            try {
                // This won't start it if it's already open
                await FileSystem.startMessages();
            } catch (ex: any) {
                this.logger.info(`Unable to check if Messages.app is running! CLI Error: ${ex?.message ?? String(ex)}`);
                msgCheckInterval.stop();
            }
        }, 150000); // Make sure messages is open every 2.5 minutes

        this.logger.info("Finished pre-start checks...");
    }

    private async postChecks(): Promise<void> {
        this.logger.info("Running post-start checks...");

        // Make sure a password is set
        const password = this.repo.getConfig("password") as string;
        const tutorialFinished = this.repo.getConfig("tutorial_is_done") as boolean;
        if (tutorialFinished && isEmpty(password)) {
            dialog.showMessageBox(this.window, {
                type: "warning",
                buttons: ["OK"],
                title: "BlueBubbles Warning",
                message: "No Password Set!",
                detail:
                    `No password is currently set. BlueBubbles will not function correctly without one. ` +
                    `Please go to the configuration page, fill in a password, and save the configuration.`
            });
        }

        // Show a warning if the time is off by a reasonable amount (5 seconds)
        try {
            const syncOffset = await FileSystem.getTimeSync();
            if (syncOffset !== null) {
                try {
                    if (Math.abs(syncOffset) >= 5) {
                        this.logger.warn(`Your macOS time is not synchronized! Offset: ${syncOffset}`);
                        this.logger.debug(`To fix your time, open terminal and run: "sudo sntp -sS time.apple.com"`);
                    }
                } catch (ex) {
                    this.logger.debug("Unable to parse time synchronization offset!");
                }
            }
        } catch (ex) {
            this.logger.debug(`Failed to get time sychronization status! Error: ${ex}`);
        }

        this.setDockIcon();

        // Check if on Big Sur+. If we are, then create a log/alert saying that
        if (isMinMonterey) {
            this.logger.debug("Warning: macOS Monterey does NOT support creating group chats due to API limitations!");
        } else if (isMinBigSur) {
            this.logger.debug("Warning: macOS Big Sur does NOT support creating group chats due to API limitations!");
        }

        // Check for contact permissions
        const contactStatus = await requestContactPermission();
        if (contactStatus === "Denied") {
            this.logger.debug(
                "Contacts authorization status is denied! You may need to manually " +
                    "allow BlueBubbles to access your contacts."
            );
        } else {
            this.logger.debug(`Contacts authorization status: ${contactStatus}`);
        }

        // Check if MacForge is running
        if (isMinCatalina && this.repo.getConfig("enable_private_api")) {
            const mfExists = await FileSystem.processIsRunning("MacForge");
            const mfHelperExists = await FileSystem.processIsRunning("MacForgeHelper");
            if (mfExists || mfHelperExists) {
                this.logger.warn(
                    "MacForge detected! BlueBubbles no longer requires MacForge, " +
                        "and it may cause issues running it alongside BlueBubbles. We " +
                        "recommend uninstalling MacForge and then rebooting your Mac."
                );
            }
        }

        try {
            const autoLockMac = this.repo.getConfig("auto_lock_mac") as boolean;
            const uptimeSeconds = os.uptime();
            if (autoLockMac && uptimeSeconds <= 300) {
                this.logger.info("Auto-locking Mac ...");
                await MacOsInterface.lock();
            }
        } catch (ex: any) {
            this.logger.debug(`Failed to auto-lock Mac! ${ex?.message ?? String(ex)}}`);
        }

        this.logger.info("Finished post-start checks...");
    }

    private setDockIcon() {
        if (!this.repo || !this.repo.db) return;

        const hideDockIcon = this.repo.getConfig("hide_dock_icon") as boolean;
        // Use app.setActivationPolicy() instead of app.dock.hide()/show().
        // setActivationPolicy is the runtime equivalent of LSUIElement in
        // Info.plist and reliably hides the app from the Dock + app
        // switcher across window-creation cycles. app.dock.hide() alone is
        // brittle: creating a BrowserWindow after the call re-promotes the
        // app to the Dock, and on macOS 26 (Tahoe) app.dock.hide() does not
        // take effect at all — neither from startup config-load nor from
        // the in-app UI toggle. The previous `app.show()` after dock.hide()
        // was also counterproductive: app.show() focuses the app, which
        // re-activates the Dock icon as a side effect.
        if (hideDockIcon) {
            app.setActivationPolicy("accessory");
        } else {
            app.setActivationPolicy("regular");
        }
    }

    /**
     * Handles a configuration change
     *
     * @param prevConfig The previous configuration
     * @param nextConfig The current configuration
     */
    private async handleConfigUpdate({ prevConfig, nextConfig }: ServerConfigChange) {
        // If the socket port changed, disconnect and reconnect
        let proxiesRestarted = false;
        if (prevConfig.socket_port !== nextConfig.socket_port) {
            await this.restartProxyServices();
            if (this.httpService) await this.httpService.restart(true);
            proxiesRestarted = true;
        }

        // Start the oauth service if the user resets the tutorial
        if (prevConfig.tutorial_is_done === true && nextConfig.tutorial_is_done === false) {
            await this.oauthService.restart();
        }

        // If we toggle the custom cert option, restart the http service
        if (prevConfig.use_custom_certificate !== nextConfig.use_custom_certificate && !proxiesRestarted) {
            if (this.httpService) await this.httpService.restart(true);
            proxiesRestarted = true;
        }

        // If the proxy service changed, we need to restart the services
        if (prevConfig.proxy_service !== nextConfig.proxy_service && !proxiesRestarted) {
            await this.restartProxyServices();
            proxiesRestarted = true;
        }

        // If the zrok proxy config has changed, we need to restart the zrok service
        if (prevConfig.zrok_reserve_tunnel !== nextConfig.zrok_reserve_tunnel && !proxiesRestarted) {
            await this.restartProxyServices();
            proxiesRestarted = true;
        }

        // If the zrok proxy config has changed, we need to restart the zrok service
        if (prevConfig.zrok_reserved_name !== nextConfig.zrok_reserved_name && !proxiesRestarted) {
            // If we previously had a reserved name and it changes from a non-empty value to an empty value,
            // we need to release the previous reserved token
            if (
                isNotEmpty(prevConfig.zrok_reserved_name as string) &&
                isEmpty(nextConfig.zrok_reserved_name as string)
            ) {
                this.logger.debug("Releasing previous Zrok reserved token due to the reserved name being cleared");
                await ZrokManager.safeRelease(prevConfig.zrok_reserved_token as string, { clearToken: true });
            }

            await this.restartProxyServices();
            proxiesRestarted = true;
        }

        // If the ngrok API key is different, restart the ngrok process
        if (prevConfig.ngrok_key !== nextConfig.ngrok_key && !proxiesRestarted) {
            await this.restartProxyServices();
            proxiesRestarted = true;
        }

        // If the ngrok subdomain key is different, restart the ngrok process
        if (prevConfig.ngrok_custom_domain !== nextConfig.ngrok_custom_domain && !proxiesRestarted) {
            await this.restartProxyServices();
            proxiesRestarted = true;
        }

        try {
            if (
                prevConfig?.server_address !== nextConfig?.server_address &&
                isNotEmpty(nextConfig?.server_address as string)
            ) {
                this.logger.debug("Dispatching server URL update from config change");
                // Emit the new server event no matter what
                await this.emitMessage(NEW_SERVER, nextConfig.server_address, "high");
                await this.fcm?.setServerUrl(true);
            }
        } catch (ex: any) {
            this.logger.error(`Failed to handle server address change! Error: ${ex?.message ?? String(ex)}`);
        }

        // Install the bundle if the Private API is turned on
        if (!nextConfig.enable_private_api && !nextConfig.enable_ft_private_api) {
            this.logger.debug("Detected Private API disable");
            await Server().privateApi.stop();

            // Start messages after so we can properly use AppleScript
            await FileSystem.executeAppleScript(startMessages());
        } else if (
            prevConfig.enable_private_api !== nextConfig.enable_private_api ||
            prevConfig.enable_ft_private_api !== nextConfig.enable_ft_private_api
        ) {
            this.logger.debug("Detected Private API selection change");
            await Server().privateApi.restart();
        } else if (prevConfig.private_api_mode !== nextConfig.private_api_mode) {
            this.logger.debug("Detected Private API Mode change");
            await Server().privateApi.restart();
        }

        // If the dock style changes
        if (prevConfig.hide_dock_icon !== nextConfig.hide_dock_icon) {
            this.setDockIcon();
        }

        // If the badge config changes
        if (prevConfig.dock_badge !== nextConfig.dock_badge) {
            if (nextConfig.dock_badge) {
                app.setBadgeCount(this.notificationCount);
            } else {
                app.setBadgeCount(0);
            }
        }

        // Check if the auto-start method is None. If it is, then we need to migrate the old "auto_start"
        // config to the new "auto_start_method" config
        const autoStart = prevConfig.auto_start as boolean;
        if (nextConfig.auto_start_method === AutoStartMethods.None) {
            if (autoStart) {
                this.logger.debug("Migrating auto-start config to new auto-start method config");
                await this.repo.setConfig("auto_start_method", AutoStartMethods.LoginItem);
            } else {
                await this.repo.setConfig("auto_start_method", AutoStartMethods.Unset);
            }
        }

        // Handle when auto start method changes
        const prevAutoStart = prevConfig.auto_start_method as AutoStartMethods;
        const nextAutoStart = nextConfig.auto_start_method as AutoStartMethods;
        if (prevAutoStart !== nextAutoStart) {
            this.log(`Auto-start method changed from ${prevAutoStart} to ${nextAutoStart}`);

            // Handle stop cases
            if (prevAutoStart === AutoStartMethods.LoginItem) {
                this.log("Disabling auto-start at login item...");
                app.setLoginItemSettings({ openAtLogin: false, openAsHidden: false });
                this.log("Auto-start at login item disabled!");
            } else if (prevAutoStart === AutoStartMethods.LaunchAgent) {
                await FileSystem.removeLaunchAgent();
            }

            // Handle start cases
            if (nextAutoStart === AutoStartMethods.LoginItem) {
                this.log("Enabling auto-start at login item...");
                app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
                this.log("Auto-start at login item enabled!");
            } else if (nextAutoStart === AutoStartMethods.LaunchAgent) {
                await FileSystem.createLaunchAgent();
            }
        }

        // Handle when auto caffeinate changes
        if (prevConfig.auto_caffeinate !== nextConfig.auto_caffeinate) {
            if (nextConfig.auto_caffeinate) {
                Server().caffeinate.start();
            } else {
                Server().caffeinate.stop();
            }
        }

        // If the password changes, we need to make sure the clients connected to the socket are kicked.
        if (prevConfig.password !== nextConfig.password) {
            this.httpService.kickClients();
        }

        this.emitToUI("config-update", nextConfig);
    }

    /**
     * Emits a notification to to your connected devices over FCM and socket
     *
     * @param type The type of notification
     * @param data Associated data with the notification (as a string)
     */
    async emitMessage(
        type: string,
        data: any,
        priority: "normal" | "high" = "normal",
        sendFcmMessage = true,
        sendSocket = true
    ) {
        if (sendSocket) {
            this.httpService?.socketServer.emit(type, data);
        }

        // Send notification to devices
        try {
            if (sendFcmMessage && FCMService.getApp()) {
                const devices = await this.repo.devices().find();
                if (isNotEmpty(devices)) {
                    const notifData = JSON.stringify(data);
                    await this.fcm?.sendNotification(
                        devices.map(device => device.identifier),
                        { type, data: notifData },
                        resolveFcmPriority(type, priority)
                    );
                }
            }
        } catch (ex: any) {
            this.logger.debug("Failed to send FCM messages!");
            this.logger.debug(ex);
        }

        // Dispatch the webhook (sometimes it's not initialized)
        this.webhookService?.dispatch({ type, data });
    }

    private getTheme() {
        nativeTheme.on("updated", () => {
            this.setTheme(nativeTheme.shouldUseDarkColors);
        });
    }

    private setTheme(shouldUseDarkColors: boolean) {
        if (shouldUseDarkColors === true) {
            this.emitToUI("theme-update", "dark");
        } else {
            this.emitToUI("theme-update", "light");
        }
    }

    async emitMessageMatch(message: Message, tempGuid: string) {
        // Insert chat & participants
        const newMessage = await insertChatParticipants(message);
        this.logger.info(`Message match found for text, [${newMessage.contentString()}]`);

        // Convert to a response JSON
        // Since we sent the message, we don't need to include the participants
        const resp = await MessageSerializer.serialize({
            message: newMessage,
            config: {
                loadChatParticipants: false
            },
            isForNotification: true
        });
        resp.tempGuid = tempGuid;

        // We are emitting this as a new message, the only difference being the included tempGuid
        await this.emitMessage(NEW_MESSAGE, resp);
    }

    async emitMessageError(message: Message, tempGuid: string = null) {
        this.logger.info(`Failed to send message: [${message.contentString()}] (Temp GUID: ${tempGuid ?? "N/A"})`);

        /**
         * ERROR CODES:
         * 4: Message Timeout
         */
        // Since this is a message send error, we don't need to include the participants
        const data = await MessageSerializer.serialize({
            message,
            config: {
                loadChatParticipants: false
            },
            isForNotification: true
        });
        if (isNotEmpty(tempGuid)) {
            data.tempGuid = tempGuid;
        }

        await this.emitMessage("message-send-error", data);
    }

    async checkPrivateApiRequirements(): Promise<Array<NodeJS.Dict<any>>> {
        const output = [];
        output.push({
            name: "SIP Disabled",
            pass: await FileSystem.isSipDisabled(),
            solution:
                `Follow our documentation on how to disable SIP: ` +
                `https://docs.bluebubbles.app/private-api/installation`
        });

        return output;
    }

    async checkPermissions(): Promise<Array<NodeJS.Dict<any>>> {
        const output = [
            {
                name: "Accessibility (Optional)",
                pass: systemPreferences.isTrustedAccessibilityClient(false),
                solution: "Open System Preferences > Security > Privacy > Accessibility, then add BlueBubbles"
            },
            {
                name: "Full Disk Access",
                pass: this.hasDiskAccess,
                solution:
                    "Open System Preferences > Security > Privacy > Full Disk Access, " +
                    "then add BlueBubbles. Lastly, restart BlueBubbles."
            }
        ];

        return output;
    }

    /**
     * Starts the chat listener service. This service will listen for new
     * iMessages from your chat database. Anytime there is a new message,
     * we will emit a message to the socket, as well as the FCM server
     */
    private async startChatListeners() {
        if (!this.hasDiskAccess) {
            AlertsInterface.create(
                "info",
                "Restart the app once 'Full Disk Access' and 'Accessibility' permissions are enabled"
            );
            return;
        }

        this.logger.info("Starting chat listeners...");

        const cache = new IMessageCache();
        this.iMessageListener = new IMessageListener({
            filePaths: [this.iMessageRepo.dbPath, this.iMessageRepo.dbPathWal],
            cache,
            repo: this.iMessageRepo
        });

        this.iMessageListener.addPoller(new MessagePoller(this.iMessageRepo, cache));

        if (isMinHighSierra) {
            this.iMessageListener.addPoller(new ChatUpdatePoller(this.iMessageRepo, cache));
        }

        this.iMessageListener.on(CHAT_READ_STATUS_CHANGED, async (item: Chat) => {
            this.logger.info(`Chat read [${item.guid}]`);
            await Server().emitMessage(CHAT_READ_STATUS_CHANGED, {
                chatGuid: item.guid,
                read: true
            });
        });

        /**
         * Message listener for my messages only. We need this because messages from ourselves
         * need to be fully sent before forwarding to any clients. If we emit a notification
         * before the message is sent, it will cause a duplicate.
         */
        this.iMessageListener.on("new-entry", item => this.handleNewMessage(item));

        /**
         * Message listener checking for updated messages. This means either the message's
         * delivered date or read date have changed since the last time we checked the database.
         */
        this.iMessageListener.on("updated-entry", item => this.handleUpdatedMessage(item));

        /**
         * Message listener for messages that have errored out
         */
        this.iMessageListener.on("message-send-error", async (item: Message) => {
            await this.emitMessageError(item);
        });

        this.iMessageListener.on("name-change", async (item: Message) => {
            this.logger.info(`Group name for [${item.cacheRoomnames}] changed to [${item.groupTitle}]`);

            // Manually send the message to the socket so we can serialize it with
            // all the extra data
            this.httpService.socketServer.emit(
                GROUP_NAME_CHANGE,
                await MessageSerializer.serialize({
                    message: item,
                    config: {
                        loadChatParticipants: true,
                        includeChats: true
                    }
                })
            );

            // Group name changes don't require the participants to be loaded
            await this.emitMessage(
                GROUP_NAME_CHANGE,
                await MessageSerializer.serialize({
                    message: item,
                    config: {
                        loadChatParticipants: false
                    },
                    isForNotification: true
                }),
                "normal",
                true,
                false
            );
        });

        this.iMessageListener.on("participant-removed", async (item: Message) => {
            const from = item.isFromMe || item.handleId === 0 ? "You" : obfuscatedHandle(item.handle?.id);
            this.logger.info(`[${from}] removed [${item.otherHandle}] from [${item.cacheRoomnames}]`);

            // Manually send the message to the socket so we can serialize it with
            // all the extra data
            this.httpService.socketServer.emit(
                PARTICIPANT_REMOVED,
                await MessageSerializer.serialize({
                    message: item,
                    config: {
                        loadChatParticipants: true,
                        includeChats: true
                    }
                })
            );

            await this.emitMessage(
                PARTICIPANT_REMOVED,
                await MessageSerializer.serialize({
                    message: item,
                    isForNotification: true
                }),
                "normal",
                true,
                false
            );
        });

        this.iMessageListener.on("participant-added", async (item: Message) => {
            const from = item.isFromMe || item.handleId === 0 ? "You" : obfuscatedHandle(item.handle?.id);
            this.logger.info(`[${from}] added [${item.otherHandle}] to [${item.cacheRoomnames}]`);

            // Manually send the message to the socket so we can serialize it with
            // all the extra data
            this.httpService.socketServer.emit(
                PARTICIPANT_ADDED,
                await MessageSerializer.serialize({
                    message: item,
                    config: {
                        loadChatParticipants: true,
                        includeChats: true
                    }
                })
            );

            await this.emitMessage(
                PARTICIPANT_ADDED,
                await MessageSerializer.serialize({
                    message: item,
                    isForNotification: true
                }),
                "normal",
                true,
                false
            );
        });

        this.iMessageListener.on("participant-left", async (item: Message) => {
            const from = item.isFromMe || item.handleId === 0 ? "You" : obfuscatedHandle(item.handle?.id);
            this.logger.info(`[${from}] left [${item.cacheRoomnames}]`);

            // Manually send the message to the socket so we can serialize it with
            // all the extra data
            this.httpService.socketServer.emit(
                PARTICIPANT_LEFT,
                await MessageSerializer.serialize({
                    message: item,
                    config: {
                        loadChatParticipants: true,
                        includeChats: true
                    }
                })
            );

            await this.emitMessage(
                PARTICIPANT_LEFT,
                await MessageSerializer.serialize({
                    message: item,
                    isForNotification: true
                }),
                "normal",
                true,
                false
            );
        });

        this.iMessageListener.on("group-icon-changed", async (item: Message) => {
            const from = item.isFromMe || item.handleId === 0 ? "You" : obfuscatedHandle(item.handle?.id);
            this.logger.info(`[${from}] changed a group photo`);

            // Manually send the message to the socket so we can serialize it with
            // all the extra data
            this.httpService.socketServer.emit(
                GROUP_ICON_CHANGED,
                await MessageSerializer.serialize({
                    message: item,
                    config: {
                        loadChatParticipants: true,
                        includeChats: true
                    }
                })
            );

            await this.emitMessage(
                GROUP_ICON_CHANGED,
                await MessageSerializer.serialize({
                    message: item,
                    isForNotification: true
                }),
                "normal",
                true,
                false
            );
        });

        this.iMessageListener.on("group-icon-removed", async (item: Message) => {
            const from = item.isFromMe || item.handleId === 0 ? "You" : obfuscatedHandle(item.handle?.id);
            this.logger.info(`[${from}] removed a group photo`);

            // Manually send the message to the socket so we can serialize it with
            // all the extra data
            this.httpService.socketServer.emit(
                GROUP_ICON_REMOVED,
                await MessageSerializer.serialize({
                    message: item,
                    config: {
                        loadChatParticipants: true,
                        includeChats: true
                    }
                })
            );

            await this.emitMessage(
                GROUP_ICON_REMOVED,
                await MessageSerializer.serialize({
                    message: item,
                    isForNotification: true
                }),
                "normal",
                true,
                false
            );
        });

        this.iMessageListener.on("error", (error: Error) => this.logger.error(error.message));

        // Start the listeners with a 500ms delay between each to prevent locks.
        this.iMessageListener.start();
    }

    private async handleNewMessage(item: Message) {
        const newMessage = await insertChatParticipants(item);
        this.logger.info(
            `New Message from ${
                newMessage.isFromMe ? "You" : obfuscatedHandle(newMessage.handle?.id)
            }, ${newMessage.contentString()}`
        );

        // Manually send the message to the socket so we can serialize it with
        // all the extra data
        this.httpService.socketServer.emit(
            NEW_MESSAGE,
            await MessageSerializer.serialize({
                message: newMessage,
                config: {
                    parseAttributedBody: true,
                    parseMessageSummary: true,
                    parsePayloadData: true,
                    loadChatParticipants: false,
                    includeChats: true
                }
            })
        );

        // Emit it to the FCM devices, but not socket
        await this.emitMessage(
            NEW_MESSAGE,
            await MessageSerializer.serialize({
                message: newMessage,
                config: {
                    enforceMaxSize: true
                },
                isForNotification: true
            }),
            newMessage.isFromMe ? "normal" : "high",
            true,
            false
        );
    }

    private async handleUpdatedMessage(item: Message) {
        const msg = await insertChatParticipants(item);

        // ATTENTION: If "from" is null, it means you sent the message from a group chat
        // Check the isFromMe key prior to checking the "from" key
        const from = msg.isFromMe ? "You" : obfuscatedHandle(msg.handle?.id);

        // Husky pre-commit validator was complaining, so I created vars
        const content = msg.contentString();
        const localeTime = msg.lastUpdateTime?.toLocaleString();
        this.logger.info(`${msg.messageStatus} message from [${from}]: [${content}] - [${localeTime}]`);

        // Manually send the message to the socket so we can serialize it with
        // all the extra data
        this.httpService.socketServer.emit(
            MESSAGE_UPDATED,
            await MessageSerializer.serialize({
                message: msg,
                config: {
                    parseAttributedBody: true,
                    parseMessageSummary: true,
                    parsePayloadData: true,
                    loadChatParticipants: false,
                    includeChats: true
                }
            })
        );

        // Emit it to the FCM devices only
        // Since this is a message update, we do not need to include the participants or chats
        await this.emitMessage(
            MESSAGE_UPDATED,
            await MessageSerializer.serialize({
                message: msg,
                config: {
                    loadChatParticipants: false,
                    includeChats: false
                },
                isForNotification: true
            }),
            "normal",
            true,
            false
        );
    }

    private removeChatListeners() {
        // Remove all listeners
        this.logger.info("Removing chat listeners...");
        this.iMessageListener?.stop();
        this.iMessageListener = null;
    }

    /**
     * Restarts the server
     */
    async hotRestart() {
        this.logger.info("Restarting the server...");

        // Disconnect & reconnect to the iMessage DB
        if (this.iMessageRepo.db.isInitialized) {
            this.logger.info("Reconnecting to iMessage database...");
            await this.iMessageRepo.db.destroy();
            await this.iMessageRepo.db.initialize();
        }

        await this.stopServices();
        await this.startServices();
    }

    buildRelaunchArgs() {
        // Relaunch the process
        const args = process.argv.slice(1);

        const removeArg = (name: string) => {
            const oauthIndex = args.findIndex(i => i === `--${name}`);
            if (oauthIndex !== -1) {
                // Remove the next arg if it's not a flag
                if (args[oauthIndex + 1] && !args[oauthIndex + 1].startsWith("--")) {
                    args.splice(oauthIndex, 2);
                } else {
                    args.splice(oauthIndex, 1);
                }
            }
        };

        // If we are persisting configs, remove any flags that are stored in the DB
        const persist = this.args["persist-config"] ?? true;
        if (persist) {
            const configKeys = Object.keys(Server().repo.config);
            for (const key of configKeys) {
                // Add the underscored or dashed version of the option.
                const keyOpts = [key];
                if (key.includes("_")) {
                    keyOpts.push(key.replace(/_/g, "-"));
                } else if (key.includes("-")) {
                    keyOpts.push(key.replace(/-/g, "_"));
                }

                for (const opt of keyOpts) {
                    removeArg(opt);
                }
            }
        }

        // Remove the oauth-token flag & value if it exists.
        removeArg("oauth-token");

        // Remove the disable-gpu flag and re-add it if enabled
        removeArg("disable-gpu");
        const noGpu = Server().repo.getConfig("disable_gpu") ?? false;
        if (noGpu) {
            args.push("--disable-gpu");
        }

        return args;
    }

    async relaunch({
        exit = true,
        quit = false
    }: {
        exit?: boolean;
        quit?: boolean;
    } = {}) {
        this.isRestarting = true;

        // Close everything gracefully
        await this.stopAll();

        // Relaunch the process
        let args = this.buildRelaunchArgs();
        args = args.concat(["--relaunch"]);

        // Relaunch the app
        app.relaunch({ args });

        if (quit) {
            app.quit();
        } else if (exit) {
            app.exit(0);
        }
    }

    async stopAll() {
        await this.stopServices();
        await this.stopServerComponents();
    }

    async restartViaTerminal() {
        this.isRestarting = true;

        // Close everything gracefully
        await this.stopAll();

        let relaunchArgs = this.buildRelaunchArgs();
        relaunchArgs = [process.execPath, ...relaunchArgs];

        // Kick off the restart script
        FileSystem.executeAppleScript(runTerminalScript(relaunchArgs.join(" ")));

        // Exit the current instance
        app.exit(0);
    }
}
