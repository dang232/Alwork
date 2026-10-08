import { startDesktopCallbackListener as defaultStartDesktopCallbackListener } from '../desktop-auth/desktop-callback-listener.js';
import { recordStartupPerformance } from './startup-performance.js';

export const createStartupPipelineRuntime = (dependencies) => {
  const {
    createTerminalRuntime,
    createDictationRuntime,
    createMessageStreamWsRuntime,
    createServerStartupRuntime,
    startDesktopCallbackListener = defaultStartDesktopCallbackListener,
  } = dependencies;

  const run = async (options) => {
    const pipelineStartedAt = performance.now();
    recordStartupPerformance('web.pipeline.start');
    const {
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      globalEventHub,
      processForwardedEventPayload,
      messageStreamWsClients,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
      terminalHeartbeatIntervalMs,
      terminalRebindWindowMs,
      terminalMaxRebindsPerWindow,
      environmentRuntime = null,
      setupProxy,
      scheduleOpenCodeApiDetection,
      bootstrapOpenCodeAtStartup,
      onListenerReady = null,
      staticRoutesRuntime,
      process,
      crypto,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      syncToHmrState,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      host,
      port,
      startupTunnelRequest,
      onTunnelReady,
      tunnelRuntimeContext,
      attachSignals,
      apiOnly,
      dictationModelsDir,
      // The desktop-auth runtime's own callback registrar (shares its
      // pending-request map with the login start). Required: without it the
      // fixed-port listener cannot serve, so startup fails loudly below
      // instead of silently losing Google logins.
      registerDesktopGoogleCallbackRoute = null,
    } = options;

    const terminalRuntime = createTerminalRuntime({
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: terminalHeartbeatIntervalMs,
      TERMINAL_INPUT_WS_REBIND_WINDOW_MS: terminalRebindWindowMs,
      TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: terminalMaxRebindsPerWindow,
      environmentRuntime,
    });

    const dictationRuntime = createDictationRuntime({
      app,
      server,
      express,
      uiAuthController,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      modelsDir: dictationModelsDir,
    });

    const messageStreamRuntime = createMessageStreamWsRuntime({
      server,
      uiAuthController,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      globalEventHub,
      processForwardedEventPayload,
      wsClients: messageStreamWsClients,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
    });

    setupProxy(app);

    if (apiOnly) {
      staticRoutesRuntime.registerApiOnlyFallbackRoutes(app);
    } else {
      staticRoutesRuntime.registerStaticRoutes(app);
    }

    const serverStartupRuntime = createServerStartupRuntime({
      process,
      crypto,
      server,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      syncToHmrState,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
    });

    const bindHost = serverStartupRuntime.resolveBindHost(host);
    const startupResult = await serverStartupRuntime.startListeningAndMaybeTunnel({
      port,
      bindHost,
      startupTunnelRequest,
      onTunnelReady,
    });
    recordStartupPerformance('web.listener.ready', {
      durationMs: performance.now() - pipelineStartedAt,
    });
    tunnelRuntimeContext.setActivePort(startupResult.activePort);
    // Dev layouts serve on dynamic ports, but the registered Google redirect
    // is fixed: bind the loopback callback listener (skips when the main
    // server already serves on the fixed port). It closes with the main
    // server, so embedded restarts never leak it.
    const desktopCallbackListener = await startDesktopCallbackListener({
      express,
      registerCallbackRoute: registerDesktopGoogleCallbackRoute,
      activePort: startupResult.activePort,
    });
    server.once('close', () => {
      void desktopCallbackListener.stop().catch(() => {});
    });
    if (onListenerReady) await onListenerReady();
    scheduleOpenCodeApiDetection();
    void bootstrapOpenCodeAtStartup();

    serverStartupRuntime.attachProcessHandlers({ attachSignals });

    return {
      terminalRuntime,
      dictationRuntime,
      messageStreamRuntime,
      desktopCallbackListener,
    };
  };

  return {
    run,
  };
};
