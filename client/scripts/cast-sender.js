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
   * Initialize the Cast framework. Resolves once the framework is available
   * (or immediately reports unavailable if the browser has no Cast support).
   * @returns {Promise<boolean>} Whether the Cast framework became available.
   */
  init() {
    return new Promise((resolve) => {
      const start = () => {
        try {
          this.#initializeContext();
          resolve(true);
        } catch (error) {
          console.error("Cast initialization failed:", error);
          resolve(false);
        }
      };

      if (window.cast && window.cast.framework && window.chrome?.cast) {
        start();
        return;
      }

      window.__onGCastApiAvailable = (isAvailable) => {
        if (isAvailable) {
          start();
        } else {
          resolve(false);
        }
      };

      // If the framework never loads (e.g. non-Chromium browser), resolve false.
      setTimeout(() => {
        if (!this.#ready) {
          resolve(false);
        }
      }, 5_000);
    });
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
      (event) => this.#onStateChange(event.castState),
    );

    this.#context.addEventListener(
      castNs.framework.CastContextEventType.SESSION_STATE_CHANGED,
      (event) => {
        this.#onSessionChange(event.sessionState);
        this.#attachSessionMessageListener();
      },
    );

    this.#ready = true;
    this.#onStateChange(this.#context.getCastState());
    this.#attachSessionMessageListener();
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

    const errorCode = await this.#context.requestSession();

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
