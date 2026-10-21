/**
 * Webex Web SDK meetings wrapper for the browser client.
 *
 * Uses the global `Webex` UMD build loaded in index.html to register the
 * signed-in user, join a meeting, publish the browser microphone/camera, and
 * render the remote audio/video/share streams into the supplied media elements.
 *
 * Media is intentionally joined in transcoded (non-multistream) mode so the
 * simple `media:ready` event surface can be used to wire up remote streams.
 */

import { isVerboseDebug } from "./debug-console.js";

const DEFAULT_MEDIA_SETTINGS = {
  receiveAudio: true,
  receiveVideo: true,
  receiveShare: true,
  sendAudio: true,
  sendVideo: true,
  sendShare: false,
};

const READY_TIMEOUT_MS = 30_000;

/**
 * Resolve once the Webex SDK instance has finished initializing.
 * @param {object} webex - Instance returned by Webex.init().
 */
function waitForWebexReady(webex) {
  if (webex.ready) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          "Webex SDK did not become ready. The access token may be invalid, expired, or missing required scopes.",
        ),
      );
    }, READY_TIMEOUT_MS);

    webex.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

class MeetingsClient {
  #webex = null;
  #meeting = null;
  #registered = false;
  #localStreams = { microphone: null, camera: null };
  #elements;
  #onEvent;
  #joined = false;

  /**
   * @param {object} options
   * @param {string} options.accessToken - Webex OAuth access token.
   * @param {object} [options.elements] - Media elements to attach streams to.
   * @param {HTMLVideoElement} [options.elements.localVideo]
   * @param {HTMLVideoElement} [options.elements.remoteVideo]
   * @param {HTMLAudioElement} [options.elements.remoteAudio]
   * @param {HTMLVideoElement} [options.elements.remoteShare]
   * @param {(event: {type: string, [key: string]: unknown}) => void} [options.onEvent]
   */
  constructor({ accessToken, elements = {}, onEvent } = {}) {
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("A Webex access token is required to join meetings.");
    }

    if (typeof window === "undefined" || !window.Webex) {
      throw new Error(
        "The Webex Web SDK failed to load. Check the webex.min.js script tag.",
      );
    }

    this.accessToken = accessToken;
    this.#elements = elements;
    this.#onEvent = typeof onEvent === "function" ? onEvent : () => {};
  }

  get joined() {
    return this.#joined;
  }

  #emit(type, detail = {}) {
    console.log(`[meeting] ${type}`, detail);
    this.#onEvent({ type, ...detail });
  }

  /** Initialize the SDK and register the device for meetings. */
  async register() {
    if (this.#registered) {
      return;
    }

    this.#webex = window.Webex.init({
      credentials: { access_token: this.accessToken },
      ...(isVerboseDebug() && { config: { logger: { level: "debug" } } }),
    });

    // The SDK only wires up its internal metrics/logging in its `ready`
    // handler. Calling meetings.register() earlier throws a misleading
    // "Cannot read properties of undefined (reading 'internal')" that masks the
    // real error, so wait for `ready` first.
    await waitForWebexReady(this.#webex);
    await this.#webex.meetings.register();
    this.#registered = true;
    this.#emit("registered");
  }

  /**
   * Create local microphone and camera streams from the browser.
   * Missing devices/permissions degrade gracefully to a receive-only join.
   */
  async #createLocalStreams() {
    const mediaHelpers = this.#webex?.meetings?.mediaHelpers;

    if (!mediaHelpers) {
      return;
    }

    try {
      this.#localStreams.microphone =
        await mediaHelpers.createMicrophoneStream({ audio: true });
    } catch (error) {
      this.#emit("mediaWarning", {
        message: `Microphone unavailable: ${error?.message || error}`,
      });
    }

    try {
      this.#localStreams.camera = await mediaHelpers.createCameraStream({
        video: true,
      });

      if (this.#elements.localVideo) {
        this.#elements.localVideo.srcObject =
          this.#localStreams.camera.outputStream;
      }
    } catch (error) {
      this.#emit("mediaWarning", {
        message: `Camera unavailable: ${error?.message || error}`,
      });
    }
  }

  #bindMediaReady() {
    if (!this.#meeting) {
      return;
    }

    this.#meeting.on("media:ready", (media) => {
      if (!media?.stream) {
        return;
      }

      const map = {
        local: this.#elements.localVideo,
        remoteVideo: this.#elements.remoteVideo,
        remoteAudio: this.#elements.remoteAudio,
        remoteShare: this.#elements.remoteShare,
      };

      const element = map[media.type];

      if (element) {
        element.srcObject = media.stream;
      }

      this.#emit("mediaReady", { mediaType: media.type });
    });

    this.#meeting.on("media:stopped", (media) => {
      const element = {
        remoteVideo: this.#elements.remoteVideo,
        remoteAudio: this.#elements.remoteAudio,
        remoteShare: this.#elements.remoteShare,
      }[media?.type];

      if (element) {
        element.srcObject = null;
      }

      this.#emit("mediaStopped", { mediaType: media?.type });
    });

    this.#meeting.on("meeting:self:lobbyWaiting", () => {
      this.#emit("lobby");
    });
  }

  #bindMeetingLifecycle() {
    if (!this.#meeting) {
      return;
    }

    this.#meeting.on("meeting:ended", () => {
      this.#joined = false;
      this.#emit("ended");
    });
  }

  /**
   * Join a meeting and publish/receive media.
   * @param {string} destination - SIP address or meeting link.
   * @returns {Promise<object>} The joined meeting instance.
   */
  async joinMeeting(destination) {
    if (!destination || typeof destination !== "string" || !destination.trim()) {
      throw new Error("A meeting destination is required.");
    }

    await this.register();

    this.#emit("joining", { destination });

    // NOTE: don't use the SDK's PERSONAL_ROOM destination type. In 3.12 it
    // re-resolves the already-resolved {userId, orgId} through a Hydra people
    // lookup (HTTP 400) and then sends a malformed join. Use the PMR's link or
    // SIP address instead (see joinPersonalRoom in main.js).
    this.#meeting = await this.#webex.meetings.create(destination.trim());
    this.#bindMediaReady();
    this.#bindMeetingLifecycle();

    await this.#createLocalStreams();

    await this.#meeting.join({ enableMultistream: false });

    await this.#meeting.addMedia({
      localStreams: {
        microphone: this.#localStreams.microphone || undefined,
        camera: this.#localStreams.camera || undefined,
      },
      audioEnabled: Boolean(this.#localStreams.microphone),
      videoEnabled: Boolean(this.#localStreams.camera),
      allowMediaInLobby: true,
      additionalMediaOptions: {
        receiveAudio: DEFAULT_MEDIA_SETTINGS.receiveAudio,
        receiveVideo: DEFAULT_MEDIA_SETTINGS.receiveVideo,
        sendAudio: Boolean(this.#localStreams.microphone),
        sendVideo: Boolean(this.#localStreams.camera),
      },
    });

    this.#joined = true;
    this.#emit("joined", { destination });

    return this.#meeting;
  }

  /** Toggle whether the local microphone is muted. */
  async setAudioMuted(muted) {
    const stream = this.#localStreams.microphone;

    if (!stream || typeof stream.setMuted !== "function") {
      return false;
    }

    stream.setMuted(muted);
    this.#emit("audioMuteChanged", { muted });
    return true;
  }

  /** Toggle whether the local camera is muted. */
  async setVideoMuted(muted) {
    const stream = this.#localStreams.camera;

    if (!stream || typeof stream.setMuted !== "function") {
      return false;
    }

    stream.setMuted(muted);
    this.#emit("videoMuteChanged", { muted });
    return true;
  }

  #stopLocalStreams() {
    for (const key of ["microphone", "camera"]) {
      const stream = this.#localStreams[key];

      if (stream && typeof stream.stop === "function") {
        try {
          stream.stop();
        } catch {
          // ignore stream stop failures during teardown
        }
      }

      this.#localStreams[key] = null;
    }

    for (const element of [
      this.#elements.localVideo,
      this.#elements.remoteVideo,
      this.#elements.remoteAudio,
      this.#elements.remoteShare,
    ]) {
      if (element) {
        element.srcObject = null;
      }
    }
  }

  /** Leave the current meeting and release local media. */
  async leave() {
    this.#stopLocalStreams();

    if (this.#meeting) {
      try {
        await this.#meeting.leave();
      } catch (error) {
        this.#emit("leaveError", { message: error?.message || String(error) });
      }
    }

    this.#meeting = null;
    this.#joined = false;
    this.#emit("left");
  }
}

export default MeetingsClient;
