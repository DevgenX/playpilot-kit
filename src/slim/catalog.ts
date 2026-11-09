/**
 * Background services an iOS simulator runs that a game under test does not need, grouped so a profile can keep
 * a whole group (for example "store" for games with in-app purchases). Checked on the iOS 27 simulator runtime:
 * with every group off, the simulator boots in seconds, apps launch, and it runs about 90 processes instead of 230.
 *
 * Never add these (switching them off breaks the simulator):
 *   com.apple.nanoregistryd   app launches and boot-complete hang
 * Game services (Game Center, game controllers, saved games) are deliberately absent so games keep working.
 */

export interface SlimCategory {
  readonly id: string;
  readonly title: string;
  /** What stops working while the group is off. */
  readonly effect: string;
  readonly labels: readonly string[];
}

const apple = (names: readonly string[]): string[] => names.map((n) => `com.apple.${n}`);

export const CATEGORIES: readonly SlimCategory[] = [
  {
    id: "widgets",
    title: "Widgets and wallpaper",
    effect: "Home Screen widgets, wallpaper posters and Live Activities stop updating.",
    labels: apple(["chronod", "liveactivitiesd", "contacts.postersyncd", "PosterBoard"]),
  },
  {
    id: "siri",
    title: "Siri and on-device intelligence",
    effect: "Siri, dictation, translation and Apple Intelligence features are unavailable.",
    labels: apple(["assistant_cdmd", "assistant_service", "assistantd", "corespeechd", "siriactionsd", "siriinferenced", "siriknowledged", "sirittsd", "speechmaintenanced", "voicebankingd", "generativeexperiencesd", "GenerativeFunctions.agentstored", "imageplaygroundd", "intelligencecontextd", "intelligenceflowd", "intelligenceplatformd", "intelligencetasksd", "knowledgeconstructiond", "modelcatalogd", "modelmanagerd", "naturallanguaged", "textunderstandingd", "translationd", "callintelligenced", "Archetype.textcontextd", "synapse.contentlinkingd", "proactiveeventtrackerd", "textcomposerd", "shazamd", "shazameventsd"]),
  },
  {
    id: "search",
    title: "Spotlight and search",
    effect: "Spotlight and system search return nothing.",
    labels: apple(["searchd", "searchtoold", "corespotlightservice", "spotlightknowledged", "spotlightknowledged.updater", "hybridsearchd", "fileindexerd"]),
  },
  {
    id: "icloud",
    title: "iCloud and Apple Account",
    effect: "iCloud sync, Keychain sync, backup and Apple Account screens do not work. CloudKit (cloudd) is not touched.",
    labels: apple(["bird", "CloudSettingsSyncAgent", "cdpd", "cksharingmanagementd", "icloudmailagent", "icloudsubscriptionoptimizerd", "protectedcloudstorage.protectedcloudkeysyncing", "SecureBackupDaemon", "EscrowSecurityAlert", "security.CircleJoinRequested", "security.cloudkeychainproxy3", "keychainsharingmessagingd", "syncdefaultsd", "appleaccountd", "appleaccounttransparencyd", "followupd", "cmfsyncagent"]),
  },
  {
    id: "store",
    title: "App Store, StoreKit and push",
    effect: "In-app purchases (StoreKit), remote push notifications and media library services do not work.",
    labels: apple(["appstored", "appstorecomponentsd", "itunesstored", "storekitd", "amsaccountsd", "amsengagementd", "amsondevicestoraged", "apsd", "ap.adprivacyd", "ap.promotedcontentd", "jetpackassetd", "itunescloudd", "musicd", "medialibraryd", "mediaartworkd", "webkit.adattributiond"]),
  },
  {
    id: "pim",
    title: "Mail, Calendar and Contacts",
    effect: "Calendar, Reminders, Mail, suggestions and contact pickers may fail.",
    labels: apple(["calaccessd", "dataaccess.dataaccessd", "exchangesyncd", "email.maild", "remindd", "ABDatabaseDoctor", "suggestd", "peopled", "recentsd", "mobiletimerd"]),
  },
  {
    id: "web",
    title: "Safari services",
    effect: "Universal links, Safari sync and web push do not work. WebKit itself is not touched.",
    labels: apple(["Safari.History", "Safari.passwordbreachd", "Safari.SafeBrowsing.Service", "SafariBookmarksSyncAgent", "safarifetcherd", "WebBookmarks.webbookmarksd", "webkit.webpushd", "webprivacyd", "swcd", "security.swcagent", "browserkitd", "guidedbrowsingd"]),
  },
  {
    id: "family",
    title: "Family and Screen Time",
    effect: "Family Sharing, Screen Time and app limits do not work.",
    labels: apple(["familycircled", "FamilyControlsAgent", "familynotificationd", "ScreenTimeAgent", "ScreenTimeSettingsAgent", "UsageTrackingAgent", "ManagedSettingsAgent", "asktod"]),
  },
  {
    id: "health",
    title: "Health, Home and Fitness",
    effect: "HealthKit, HomeKit and Fitness do not work.",
    labels: apple(["healthd", "healthappd", "healthcontentd", "healtheventsd", "healthrecordsd", "homed", "homeeventsd", "fitcore", "fitcore.session", "fitnesscoachingd", "fitnessintelligenced", "activityawardsd", "activitysharingd", "sleepd", "sensorkitd"]),
  },
  {
    id: "photos",
    title: "Photos analysis and sync",
    effect: "Photo analysis, shared albums and stickers do not work. The photo library (assetsd) is not touched.",
    labels: apple(["photoanalysisd", "mediaanalysisd", "mediaanalysisd.service", "photosface", "cloudphotod", "assetsd.nebulad", "mediastream.mstreamd", "avatarsd", "stickersd"]),
  },
  {
    id: "apps",
    title: "News, Weather, Maps and Wallet",
    effect: "News, Weather, Maps data and Wallet are unavailable.",
    labels: apple(["newsd", "weatherd", "navd", "geoanalyticsd", "maps.destinationd", "Maps.geocorrectiond", "Maps.mapssyncd", "Maps.pushdaemon", "bookdatastored", "tipsd", "financed", "finhealthd", "passd", "merchantd", "videosubscriptionsd", "tvremoted"]),
  },
  {
    id: "messaging",
    title: "Messages, FaceTime and calls",
    effect: "iMessage, FaceTime and calling services do not work.",
    labels: apple(["identityservicesd", "ids_simd", "idscredentialsagent", "idsremoteurlconnectionagent", "imautomatichistorydeletionagent", "imtransferagent", "facetimemessagestored", "messagesescrowd", "avconferenced", "telephonyutilities.callservicesd", "StatusKitAgent", "communicationtrustd", "announced"]),
  },
  {
    id: "connectivity",
    title: "Watch, CarPlay and nearby devices",
    effect: "Apple Watch sync, CarPlay, AirDrop discovery and Find My do not work. The share sheet service (sharingd) is not touched.",
    labels: apple(["rapportd", "companiond", "nanobackupd", "nanoprefsyncd", "nanoregistrylaunchd", "nanotimekitcompaniond", "carkitd", "CarPlayApp", "findmy.findmylocated", "devicesharingd", "resourcegrabberd.companion"]),
  },
  {
    id: "analytics",
    title: "Diagnostics and experiments",
    effect: "System analytics, feedback and server-side experiments stop. Crash reporting is not touched.",
    labels: apple(["triald", "rtcreportingd", "feedbackd", "securityuploadd", "diagnosticextensionsd"]),
  },
];

export const CATEGORY_IDS: readonly string[] = CATEGORIES.map((c) => c.id);

/** Every label any profile may switch off. PlayPilot never touches a service outside this list. */
export const ALL_LABELS: ReadonlySet<string> = new Set(CATEGORIES.flatMap((c) => c.labels));
