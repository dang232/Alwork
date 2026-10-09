import { OpenCode } from '@opencode/client';
import { registerNotificationEmitRoutes } from '../notifications/emit-route.js';
import { ALCORE_PROVIDER_ID, createAlcoreProviderRuntime } from '../alcore-provider/alcore-provider.js';
import { upsertProviderConfig, removeProviderConfig } from './providers.js';
import { sharedUserTokenStore } from '../user-tokens/user-token-store.js';

export const createBootstrapRuntime = (dependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerOpenChamberRoutes,
    registerAgentToolRoutes = () => {},
    express,
  } = dependencies;

  const setupBaseRoutes = (app, options) => {
    const {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerPort,
      getTunnelUrl,
      verboseRequestLogs,
      alcoreSecret,
      alcorePreviousSecret,
      alcoreIssuer,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      sayTTSCapability,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      fetchFreeZenModels,
      getCachedZenModels,
      setAutoAcceptSession,
      agentToolRuntime,
      pluginNotificationEmitter,
      desktopUpdater,
      skipBodyParsing,
      // OpenCode credential provisioning for the Alcore badge flip.
      // Optional (tests + runtimes without a managed OpenCode omit them):
      // without both, the provider block still registers but no OpenCode
      // credential is stored. Read per call — the port and server password
      // both move across an OpenCode restart.
      buildOpenCodeUrl = null,
      getOpenCodeAuthHeaders = null,
    } = options;

    const uiAuthController = createUiAuth({
      alcoreSecret,
      alcorePreviousSecret,
      alcoreIssuer,
      readSettingsFromDiskMigrated,
      clientAuthController: remoteClientAuthRuntime,
    });
    if (uiAuthController.enabled) {
      console.log('Alcore login required for browser sessions');
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerId,
      getServerPort,
      getTunnelUrl,
      tunnelAuthController,
      uiAuthController,
    });

    registerCommonRequestMiddleware(app, { express, verboseRequestLogs, skipBodyParsing });

    registerAgentToolRoutes(app, { express, agentToolRuntime });

    const notificationEmitRoutes = registerNotificationEmitRoutes(app, {
      express,
      isAgentToolRequestAuthorized: (req) => agentToolRuntime?.authorizeRequest?.(req) === true,
      emitter: pluginNotificationEmitter,
    });
    notificationEmitRoutes.registerPluginRoute();

    // The Alcore provider card shares the desktop-login keychain: a pair
    // captured at loopback completion is the pair the catalog sync
    // presents, and global sign-out clears it beside the provider entry.
    // The OpenCode credential is the SAME caller Bearer (never a service
    // key): stored via `integration.connect.key` so the card reads
    // Connected, removed on sign-out so no orphan survives. Unwired (no
    // OpenCode URL/auth) keeps the task-42 block-only behavior.
    const openCodeWired = buildOpenCodeUrl !== null && buildOpenCodeUrl !== undefined
      && getOpenCodeAuthHeaders !== null && getOpenCodeAuthHeaders !== undefined;
    const openCodeCredentials = openCodeWired
      ? {
        listCredentialIDs: async () => {
          const client = OpenCode.make({
            baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''),
            headers: { ...getOpenCodeAuthHeaders() },
          });
          const { data } = await client.integration.list();
          const integration = data.find((entry) => entry?.id === ALCORE_PROVIDER_ID);
          return (integration?.connections ?? [])
            .filter((connection) => connection?.type === 'credential')
            .map((connection) => connection.id);
        },
        connectKey: async (key) => {
          const client = OpenCode.make({
            baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''),
            headers: { ...getOpenCodeAuthHeaders() },
          });
          await client.integration.connect.key({ integrationID: ALCORE_PROVIDER_ID, key });
        },
        removeCredential: async (credentialID) => {
          const client = OpenCode.make({
            baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''),
            headers: { ...getOpenCodeAuthHeaders() },
          });
          await client.credential.remove({ credentialID });
        },
      }
      : null;
    const alcoreProvider = createAlcoreProviderRuntime({
      userTokenStore: sharedUserTokenStore(),
      upsertProviderConfig,
      removeProviderConfig,
      openCodeCredentials,
    });

    const authAndAccessRoutes = registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      alcoreProvider,
      alcoreSecret,
      alcorePreviousSecret,
      alcoreIssuer,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
    });

    notificationEmitRoutes.registerApiRoute();

    registerTtsRoutes(app, { sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getPendingBlockingRequestsSnapshot: sessionRuntime.getPendingBlockingRequestsSnapshot,
      getSessionAttentionSnapshot: sessionRuntime.getSessionAttentionSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      getSessionAttentionState: sessionRuntime.getSessionAttentionState,
      markSessionViewed: sessionRuntime.markSessionViewed,
      markSessionUnviewed: sessionRuntime.markSessionUnviewed,
      markUserMessageSent: sessionRuntime.markUserMessageSent,
      setPushInitialized,
      setAutoAcceptSession,
    });

    registerOpenChamberRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      readSettingsFromDiskMigrated,
      fetchFreeZenModels,
      getCachedZenModels,
      desktopUpdater,
    });

    return {
      uiAuthController,
      desktopAuthRuntime: authAndAccessRoutes?.desktopAuthRuntime ?? null,
    };
  };

  return {
    setupBaseRoutes,
  };
};
