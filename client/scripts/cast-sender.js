import { CAST_NAMESPACE } from "./config.js";

/**
 * Wrapper around the Google Cast Web Sender SDK.
 *
 * Handles framework initialization, receiver discovery/availability, requesting
 * a Cast session (device picker), and exchanging custom messages with the
 * custom Web Receiver over CAST_NAMESPACE.
 */
class CastSender {
  #applicationId;
  #namespace;
  #onStateChange;
  #onSessionChange;
  #onReceiverMessage;
  #context = null;
  #ready = false;
  #messageListenerBound = null;

  /**
   * @param {object} options
   * @param {string} options.applicationId - Custom receiver application id.
   * @param {string} [options.namespace] - Custom message namespace.
   * @param {(state: string) => void} [options.onStateChange] - Cast availability/connection changes.
   * @param {(state: string) => void} [options.onSessionChange] - Session lifecycle changes.
   * @param {(message: object) => void} [options.onReceiverMessage] - Messages from the receiver.
   */
  constructor({
    applicationId,
    namespace = CAST_NAMESPACE,
    onStateChange,
    onSessionChange,
    onReceiverMessage,
  } = {}) {
    if (!applicationId) {
      throw new Error("A Chromecast receiver application id is required.");
    }

    this.#applicationId = applicationId;
    this.#namespace = namespace;
    this.#onStateChange = onStateChange || (() => {});
    this.#onSessionChange = onSessionChange || (() => {});
    this.#onReceiverMessage = onReceiverMessage || (() => {});
  }

  get available() {
    return this.#ready;
  }

  /**
   * Initialize the Cast framework. Resolves once the framework is available,
   * or false after a timeout. If the framework loads later than the timeout it
   * is still initialized and `onStateChange` reports the new state.
   * @returns {Promise<boolean>} Whether the Cast framework became available.
   */
  init() {
    this.#logEnvironment();

    return new Promise((resolve) => {
      let settled = false;

      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      const handle = (result) => {
        if (this.#ready) {
          return;
        }

        if (!result?.isAvailable) {
          console.warn(
            `[cast] Cast framework unavailable (reason: ${result?.reason || "unknown"}). Browser may not support Cast.`,
          );
          finish(false);
          return;
        }

        try {
          this.#initializeContext();
          finish(true);
        } catch (error) {
          console.error("[cast] Cast initialization failed:", error);
          finish(false);
        }
      };

      if (window.__castApiResult) {
        handle(window.__castApiResult);
      } else if (window.cast?.framework && window.chrome?.cast) {
        handle({ isAvailable: true });
      } else {
        window.addEventListener("cast-api-ready", () =>
          handle(window.__castApiResult),
        );
      }

      setTimeout(() => {
        if (!this.#ready) {
          console.warn(
            "[cast] Cast framework did not load within 15s (cast_sender.js blocked or unsupported browser?).",
          );
          finish(false);
        }
      }, 15_000);
    });
  }

  #logEnvironment() {
    console.log("[cast] receiver application id:", this.#applicationId);
    console.log(
      "[cast] environment:",
      JSON.stringify({
        secureContext: window.isSecureContext,
        origin: window.location.origin,
        online: navigator.onLine,
        chromium: Boolean(window.chrome),
        connectionType: navigator.connection?.type || "unknown",
      }),
    );
  }

  #initializeContext() {
    const castNs = window.cast;
    const chromeCast = window.chrome.cast;

    this.#context = castNs.framework.CastContext.getInstance();
    this.#context.setOptions({
      receiverApplicationId: this.#applicationId,
      autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
      resumeSavedSession: true,
    });

    this.#context.addEventListener(
      castNs.framework.CastContextEventType.CAST_STATE_CHANGED,
      (event) => {
        console.log("[cast] state changed:", event.castState);
        this.#onStateChange(event.castState);
      },
    );

    this.#context.addEventListener(
      castNs.framework.CastContextEventType.SESSION_STATE_CHANGED,
      (event) => {
        console.log(
          "[cast] session state:",
          event.sessionState,
          event.errorCode ? `error=${event.errorCode}` : "",
        );
        this.#onSessionChange(event.sessionState);
        this.#attachSessionMessageListener();
      },
    );

    this.#ready = true;

    const initial = this.#context.getCastState();
    console.log("[cast] framework ready, initial state:", initial);
    this.#onStateChange(initial);
    this.#attachSessionMessageListener();
    this.#watchDiscovery();
  }

  /** Log a hint if no devices are found after a while. */
  #watchDiscovery() {
    const startedAt = Date.now();

    for (const seconds of [5, 15, 30, 60]) {
      setTimeout(() => {
        const state = this.getState();
        console.log(
          `[cast] ${seconds}s after init: state=${state}${
            state === "NO_DEVICES_AVAILABLE"
              ? " (no Chromecast discovered. See ?castApp=default test)"
              : ""
          }`,
        );
      }, seconds * 1000 - (Date.now() - startedAt));
    }
  }

  #attachSessionMessageListener() {
    const session = this.getSession();

    if (!session) {
      this.#messageListenerBound = null;
      return;
    }

    if (this.#messageListenerBound === session) {
      return;
    }

    this.#messageListenerBound = session;
    session.addMessageListener(this.#namespace, (_namespace, message) => {
      this.#onReceiverMessage(this.#parseMessage(message));
    });
  }

  #parseMessage(message) {
    if (message && typeof message === "object") {
      return message;
    }

    try {
      return JSON.parse(message);
    } catch {
      return { raw: message };
    }
  }

  /** Current Cast state string (from cast.framework.CastState). */
  getState() {
    return this.#context ? this.#context.getCastState() : "NO_DEVICES_AVAILABLE";
  }

  /** The active Cast session, if connected. */
  getSession() {
    return this.#context ? this.#context.getCurrentSession() : null;
  }

  isConnected() {
    return Boolean(this.getSession());
  }

  /**
   * Prompt the browser's device picker to discover and connect to a Chromecast.
   * @returns {Promise<void>}
   */
  async requestSession() {
    if (!this.#context) {
      throw new Error("Cast framework is not available in this browser.");
    }

    console.log("[cast] requesting session (device picker)");
    const errorCode = await this.#context.requestSession();
    console.log("[cast] requestSession result:", errorCode || "ok");

    if (errorCode) {
      throw new Error(`Cast session request failed: ${errorCode}`);
    }

    this.#attachSessionMessageListener();
  }

  /**
   * Send a custom message (object) to the connected receiver.
   * @param {object} message
   * @returns {Promise<void>}
   */
  async sendMessage(message) {
    const session = this.getSession();

    if (!session) {
      throw new Error("No active Cast session. Connect to a Chromecast first.");
    }

    await session.sendMessage(this.#namespace, message);
  }

  /**
   * End the current Cast session.
   * @param {boolean} [stopCasting=true] - Also stop the receiver application.
   */
  async endSession(stopCasting = true) {
    const session = this.getSession();

    if (session) {
      session.endSession(stopCasting);
    }

    this.#messageListenerBound = null;
  }
}

export default CastSender;
