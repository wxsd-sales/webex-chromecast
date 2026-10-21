import { isVerboseDebug } from "./debug-console.js";
import OAuth, { isHostedWebApp } from "./oauth.js";
import Webex from "./webex.js";
import MeetingsClient from "./meetings.js";
import CastSender from "./cast-sender.js";
import { resolveWebexApiBaseUrl, isLocalDevProxyEnabled } from "./webex-config.js";
import {
  CHROMECAST_RECEIVER_APPLICATION_ID,
  CAST_MESSAGE_TYPES,
  PERSONAL_ROOM_TYPE,
} from "./config.js";

const oauth = new OAuth();

const app = {
  dom: {},
  oauthCredentials: null,
  webex: null,
  meetingsClient: null,
  castSender: null,
  meetings: [],
  currentDestination: null,
  currentType: null,
  currentTitle: null,
  step: "signin",
  audioMuted: false,
  videoMuted: false,
  castState: "NO_DEVICES_AVAILABLE",
};

window.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
  app.dom = collectDom();
  bindUiEvents();
  initializeCast();

  initializeAuth();

  if (app.oauthCredentials) {
    await startSession();
  } else {
    setStep("signin");
  }
}

function collectDom() {
  return {
    signInBtn: document.querySelector("#signInBtn"),
    signOutBtn: document.querySelector("#signOutBtn"),
    signinMessage: document.querySelector("#signinMessage"),
    loadingMessage: document.querySelector("#loadingMessage"),
    joinForm: document.querySelector("#joinForm"),
    joinInput: document.querySelector("#joinInput"),
    joinPmrBtn: document.querySelector("#joinPmrBtn"),
    refreshMeetingsBtn: document.querySelector("#refreshMeetingsBtn"),
    meetingList: document.querySelector("#meetingList"),
    meetingTitle: document.querySelector("#meetingTitle"),
    meetingStatusKicker: document.querySelector("#meetingStatusKicker"),
    videoStage: document.querySelector("#videoStage"),
    videoPlaceholder: document.querySelector("#videoPlaceholder"),
    remoteVideo: document.querySelector("#remoteVideo"),
    remoteShare: document.querySelector("#remoteShare"),
    localVideo: document.querySelector("#localVideo"),
    remoteAudio: document.querySelector("#remoteAudio"),
    toggleAudioBtn: document.querySelector("#toggleAudioBtn"),
    toggleVideoBtn: document.querySelector("#toggleVideoBtn"),
    leaveBtn: document.querySelector("#leaveBtn"),
    castStatePill: document.querySelector("#castStatePill"),
    castStatusText: document.querySelector("#castStatusText"),
    castBtn: document.querySelector("#castBtn"),
    stopCastBtn: document.querySelector("#stopCastBtn"),
    receiverStatus: document.querySelector("#receiverStatus"),
    errorMessage: document.querySelector("#errorMessage"),
    errorRetryBtn: document.querySelector("#errorRetryBtn"),
    stepPanels: [...document.querySelectorAll("[data-step]")],
  };
}

function bindUiEvents() {
  app.dom.signInBtn?.addEventListener("click", startWebexLogin);
  app.dom.signOutBtn?.addEventListener("click", signOut);
  app.dom.joinForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const destination = app.dom.joinInput?.value?.trim();

    if (!destination) {
      return;
    }

    if (/^[\d\s-]+$/.test(destination)) {
      showError(
        "Meeting numbers can't be joined directly. Enter the meeting's SIP address (e.g. 123456789@yoursite.webex.com) or its Webex meeting link.",
      );
      return;
    }

    void joinMeeting(destination, destination);
  });
  app.dom.joinPmrBtn?.addEventListener("click", () => {
    void joinMeeting(null, "My Personal Room", PERSONAL_ROOM_TYPE);
  });
  app.dom.refreshMeetingsBtn?.addEventListener("click", () => loadMeetings());
  app.dom.meetingList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-destination]");

    if (!button) {
      return;
    }

    void joinMeeting(button.dataset.destination, button.dataset.title);
  });
  app.dom.toggleAudioBtn?.addEventListener("click", toggleAudio);
  app.dom.toggleVideoBtn?.addEventListener("click", toggleVideo);
  app.dom.leaveBtn?.addEventListener("click", leaveMeeting);
  app.dom.castBtn?.addEventListener("click", requestCast);
  app.dom.stopCastBtn?.addEventListener("click", stopCast);
  app.dom.errorRetryBtn?.addEventListener("click", () => {
    if (app.oauthCredentials) {
      void startSession();
    } else {
      setStep("signin");
    }
  });
}

/* ---------------------------------------------------------------- Auth --- */

function initializeAuth() {
  if (app.dom.signInBtn) {
    app.dom.signInBtn.disabled = !isHostedWebApp();
  }

  const auth = oauth.initialize();

  if (!auth.ok) {
    if (auth.reason && auth.reason !== "none") {
      showSigninMessage(auth.message, true);
    }
    return;
  }

  app.oauthCredentials = auth.credentials;
  oauth.saveCredentials(auth.credentials);
}

function startWebexLogin() {
  const errorMessage = oauth.startLogin();

  if (errorMessage) {
    showSigninMessage(errorMessage, true);
  }
}

async function signOut() {
  const accessToken = app.oauthCredentials?.accessToken;

  await teardownMeeting();
  await stopCast().catch(() => {});

  oauth.clearCredentials();
  app.oauthCredentials = null;
  app.webex = null;
  app.meetingsClient = null;
  app.meetings = [];
  setStep("signin");

  if (accessToken) {
    oauth.revokeToken(accessToken).catch(() => {
      /* best effort */
    });
  }
}

/* ------------------------------------------------------------- Session --- */

async function startSession() {
  if (!app.oauthCredentials?.accessToken) {
    setStep("signin");
    return;
  }

  setStep("loading");

  try {
    app.webex = new Webex(
      app.oauthCredentials.accessToken,
      resolveWebexApiBaseUrl(),
    );

    if (isLocalDevProxyEnabled()) {
      setLoadingMessage(
        "Using the local Webex API proxy (npm run proxy) for REST calls.",
      );
    }

    // Prepare the Web SDK meetings client and register in the background so
    // joining is fast. Joining awaits this registration promise.
    app.meetingsClient = new MeetingsClient({
      accessToken: app.oauthCredentials.accessToken,
      elements: {
        localVideo: app.dom.localVideo,
        remoteVideo: app.dom.remoteVideo,
        remoteAudio: app.dom.remoteAudio,
        remoteShare: app.dom.remoteShare,
      },
      onEvent: handleMeetingEvent,
    });
    app.registerError = null;
    app.registerPromise = app.meetingsClient.register().catch((error) => {
      console.error("Webex SDK registration failed:", error);
      app.registerError = error;
    });

    await loadMeetings();
    setStep("meetings");
  } catch (error) {
    showError(`Could not connect to Webex: ${formatError(error)}`);
  }
}

async function loadMeetings() {
  if (!app.webex) {
    return;
  }

  if (app.dom.refreshMeetingsBtn) {
    app.dom.refreshMeetingsBtn.disabled = true;
  }

  try {
    const now = new Date();
    const to = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);
    const meetings = await app.webex.listMeetings({
      from: now.toISOString(),
      to: to.toISOString(),
    });

    app.meetings = Array.isArray(meetings) ? meetings : [];
    renderMeetings();
  } catch (error) {
    app.meetings = [];
    renderMeetings(`Could not load meetings: ${formatError(error)}`);
  } finally {
    if (app.dom.refreshMeetingsBtn) {
      app.dom.refreshMeetingsBtn.disabled = false;
    }
  }
}

/**
 * The Web SDK's meetings.create() accepts a SIP URI, a meeting link whose path
 * contains /meet, /m/ or /join, a phone number, or a Hydra id. A bare meeting
 * number is not accepted, so prefer the SIP address from the REST API.
 */
function isSdkMeetingLink(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname.includes("webex.com") &&
      /\/(meet|m|join)\b/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function meetingDestination(meeting) {
  if (meeting.sipAddress) {
    return meeting.sipAddress;
  }

  if (meeting.webLink && isSdkMeetingLink(meeting.webLink)) {
    return meeting.webLink;
  }

  return null;
}

function renderMeetings(errorText) {
  const list = app.dom.meetingList;

  if (!list) {
    return;
  }

  list.replaceChildren();

  if (errorText) {
    list.appendChild(createMeetingEmptyItem(errorText));
    return;
  }

  const joinable = app.meetings.filter((meeting) => meetingDestination(meeting));

  if (!joinable.length) {
    list.appendChild(
      createMeetingEmptyItem(
        "No upcoming meetings found. Use the join box above to enter a meeting manually.",
      ),
    );
    return;
  }

  for (const meeting of joinable) {
    list.appendChild(createMeetingItem(meeting));
  }
}

function createMeetingEmptyItem(message) {
  const item = document.createElement("li");
  item.className = "meeting-empty";
  item.textContent = message;
  return item;
}

function createMeetingItem(meeting) {
  const item = document.createElement("li");
  item.className = "meeting-item";

  const info = document.createElement("div");
  info.className = "meeting-item__info";

  const title = document.createElement("span");
  title.className = "meeting-item__title";
  title.textContent = meeting.title || "Webex meeting";

  const time = document.createElement("span");
  time.className = "meeting-item__time";
  time.textContent = formatMeetingTime(meeting);

  info.append(title, time);

  const joinBtn = document.createElement("button");
  joinBtn.type = "button";
  joinBtn.className = "meeting-item__join";
  joinBtn.textContent = "Join";
  joinBtn.dataset.destination = meetingDestination(meeting);
  joinBtn.dataset.title = meeting.title || "Webex meeting";

  item.append(info, joinBtn);
  return item;
}

function formatMeetingTime(meeting) {
  if (!meeting.start) {
    return meeting.state ? capitalize(meeting.state) : "Scheduled";
  }

  try {
    const start = new Date(meeting.start);
    const formatter = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    return formatter.format(start);
  } catch {
    return meeting.start;
  }
}

/* ------------------------------------------------------------- Meeting --- */

async function joinMeeting(destination, title, type = null) {
  if (!destination && !type) {
    return;
  }

  if (!app.meetingsClient) {
    showError("The Webex Web SDK is not ready yet. Try again in a moment.");
    return;
  }

  app.currentDestination = destination;
  app.currentType = type;
  app.currentTitle = title || "Webex meeting";

  setStep("meeting");
  setMeetingTitle(app.currentTitle);
  setMeetingStatus("Joining…");
  resetVideoUi();

  try {
    if (app.registerPromise) {
      await app.registerPromise;
    }

    if (app.registerError) {
      throw new Error(
        `Webex SDK registration failed (${formatError(app.registerError)}). ` +
          `Granted scopes: ${app.oauthCredentials?.scopes?.join(" ") || "unknown"}. ` +
          "The integration needs spark:all and spark:kms.",
      );
    }

    await app.meetingsClient.joinMeeting(destination, type);
    setMeetingStatus("In meeting");

    // If a Chromecast session is already connected, bring it into the meeting.
    if (app.castSender?.isConnected()) {
      castCurrentMeeting();
    }
  } catch (error) {
    console.error("Join failed:", error);
    showError(`Could not join the meeting: ${formatError(error)}`);
  }
}

async function leaveMeeting() {
  await teardownMeeting();
  // Tell the receiver to leave too, but keep the Cast session available.
  if (app.castSender?.isConnected()) {
    app.castSender
      .sendMessage({ type: CAST_MESSAGE_TYPES.LEAVE_MEETING })
      .catch(() => {});
  }
  setStep("meetings");
  void loadMeetings();
}

async function teardownMeeting() {
  if (app.meetingsClient?.joined) {
    await app.meetingsClient.leave().catch(() => {});
  }

  app.currentDestination = null;
  app.currentType = null;
  app.currentTitle = null;
  app.audioMuted = false;
  app.videoMuted = false;
}

function handleMeetingEvent(event) {
  switch (event.type) {
    case "joining":
      setMeetingStatus("Joining…");
      break;
    case "joined":
      setMeetingStatus("In meeting");
      break;
    case "lobby":
      setMeetingStatus("Waiting in lobby…");
      break;
    case "mediaReady":
      handleMediaReady(event.mediaType);
      break;
    case "mediaStopped":
      handleMediaStopped(event.mediaType);
      break;
    case "mediaWarning":
      setMeetingStatus(event.message);
      break;
    case "ended":
      setMeetingStatus("Meeting ended");
      void leaveMeeting();
      break;
    default:
      break;
  }
}

function handleMediaReady(mediaType) {
  if (mediaType === "remoteVideo") {
    hideVideoPlaceholder();
  }

  if (mediaType === "remoteShare" && app.dom.remoteShare) {
    app.dom.remoteShare.hidden = false;
    app.dom.videoStage?.classList.add("video-stage--sharing");
    hideVideoPlaceholder();
  }
}

function handleMediaStopped(mediaType) {
  if (mediaType === "remoteShare" && app.dom.remoteShare) {
    app.dom.remoteShare.hidden = true;
    app.dom.videoStage?.classList.remove("video-stage--sharing");
  }
}

async function toggleAudio() {
  app.audioMuted = !app.audioMuted;
  await app.meetingsClient?.setAudioMuted(app.audioMuted);
  updateControlButton(app.dom.toggleAudioBtn, {
    active: app.audioMuted,
    icon: app.audioMuted ? "icon-microphone-muted-regular" : "icon-microphone-on-regular",
    label: app.audioMuted ? "Unmute" : "Mute",
  });
}

async function toggleVideo() {
  app.videoMuted = !app.videoMuted;
  await app.meetingsClient?.setVideoMuted(app.videoMuted);
  updateControlButton(app.dom.toggleVideoBtn, {
    active: app.videoMuted,
    icon: app.videoMuted ? "icon-camera-muted-regular" : "icon-camera-on-regular",
    label: app.videoMuted ? "Start video" : "Stop video",
  });
}

/* ---------------------------------------------------------------- Cast --- */

async function initializeCast() {
  try {
    app.castSender = new CastSender({
      applicationId: CHROMECAST_RECEIVER_APPLICATION_ID,
      onStateChange: handleCastStateChange,
      onSessionChange: handleCastSessionChange,
      onReceiverMessage: handleReceiverMessage,
    });

    const available = await app.castSender.init();

    if (!available) {
      app.castSender = null;
      updateCastUi();
    }
  } catch (error) {
    console.error("Cast unavailable:", error);
    app.castSender = null;
    updateCastUi();
  }
}

function handleCastStateChange(state) {
  app.castState = state;
  updateCastUi();
}

function handleCastSessionChange(sessionState) {
  if (sessionState === "SESSION_STARTED" || sessionState === "SESSION_RESUMED") {
    // A device connected — if we're in a meeting, push it to the TV.
    if (app.currentDestination || app.currentType) {
      castCurrentMeeting();
    }
  }

  if (sessionState === "SESSION_ENDED") {
    setReceiverStatus(null);
  }

  updateCastUi();
}

function handleReceiverMessage(message) {
  if (!message || message.type !== CAST_MESSAGE_TYPES.STATUS) {
    return;
  }

  const text = message.message || message.state || "";
  setReceiverStatus(text ? `TV: ${text}` : null);
}

function castCurrentMeeting() {
  if (!app.castSender?.isConnected() || !(app.currentDestination || app.currentType)) {
    return;
  }

  // NOTE: For this demo the receiver reuses the signed-in user's access token
  // to join the meeting over the local Cast channel. In production, mint a
  // short-lived guest token for the receiver instead of forwarding the user's.
  app.castSender
    .sendMessage({
      type: CAST_MESSAGE_TYPES.JOIN_MEETING,
      destination: app.currentDestination,
      destinationType: app.currentType,
      title: app.currentTitle,
      accessToken: app.oauthCredentials?.accessToken,
    })
    .then(() => setReceiverStatus("TV: joining meeting…"))
    .catch((error) => {
      setReceiverStatus(`TV: send failed (${formatError(error)})`);
    });
}

async function requestCast() {
  if (!app.castSender) {
    return;
  }

  try {
    await app.castSender.requestSession();
    // Joining instructions are sent from the session-state change handler.
  } catch (error) {
    setReceiverStatus(`Cast failed: ${formatError(error)}`);
  }
}

async function stopCast() {
  if (app.castSender?.isConnected()) {
    await app.castSender.endSession(true).catch(() => {});
  }
  setReceiverStatus(null);
  updateCastUi();
}

function updateCastUi() {
  const supported = Boolean(app.castSender);
  const state = supported ? app.castState : "UNSUPPORTED";
  const connected = supported && app.castSender.isConnected();

  const labels = {
    UNSUPPORTED: "Casting not supported in this browser",
    NO_DEVICES_AVAILABLE: "No Chromecast devices found",
    NOT_CONNECTED: "Chromecast available",
    CONNECTING: "Connecting to Chromecast…",
    CONNECTED: "Casting to Chromecast",
  };

  const text = labels[state] || "Chromecast";

  if (app.dom.castStatusText) {
    app.dom.castStatusText.textContent = text;
  }

  if (app.dom.castStatePill) {
    const showPill = supported && state !== "NO_DEVICES_AVAILABLE";
    app.dom.castStatePill.hidden = !showPill;
    app.dom.castStatePill.textContent = connected
      ? "Casting"
      : state === "CONNECTING"
        ? "Connecting"
        : "Cast ready";
    app.dom.castStatePill.classList.toggle("state-pill--active", connected);
  }

  if (app.dom.castBtn) {
    app.dom.castBtn.disabled =
      !supported || state === "NO_DEVICES_AVAILABLE" || connected;
    app.dom.castBtn.hidden = connected;
  }

  if (app.dom.stopCastBtn) {
    app.dom.stopCastBtn.hidden = !connected;
  }
}

/* ----------------------------------------------------------- UI helpers --- */

function setStep(step) {
  app.step = step;

  for (const panel of app.dom.stepPanels) {
    panel.hidden = panel.dataset.step !== step;
  }

  if (app.dom.signOutBtn) {
    app.dom.signOutBtn.hidden = !app.oauthCredentials;
  }
}

function setLoadingMessage(message) {
  if (app.dom.loadingMessage) {
    app.dom.loadingMessage.textContent = message;
  }
}

function showSigninMessage(message, isError = false) {
  if (!app.dom.signinMessage) {
    return;
  }

  app.dom.signinMessage.hidden = !message;
  app.dom.signinMessage.textContent = message || "";
  app.dom.signinMessage.classList.toggle("inline-message--error", isError);
}

function setMeetingTitle(title) {
  if (app.dom.meetingTitle) {
    app.dom.meetingTitle.textContent = title;
  }
}

function setMeetingStatus(status) {
  if (app.dom.meetingStatusKicker) {
    app.dom.meetingStatusKicker.textContent = status;
  }
}

function resetVideoUi() {
  if (app.dom.remoteShare) {
    app.dom.remoteShare.hidden = true;
  }
  app.dom.videoStage?.classList.remove("video-stage--sharing");
  showVideoPlaceholder();
  updateControlButton(app.dom.toggleAudioBtn, {
    active: false,
    icon: "icon-microphone-on-regular",
    label: "Mute",
  });
  updateControlButton(app.dom.toggleVideoBtn, {
    active: false,
    icon: "icon-camera-on-regular",
    label: "Stop video",
  });
}

function showVideoPlaceholder() {
  if (app.dom.videoPlaceholder) {
    app.dom.videoPlaceholder.hidden = false;
  }
}

function hideVideoPlaceholder() {
  if (app.dom.videoPlaceholder) {
    app.dom.videoPlaceholder.hidden = true;
  }
}

function updateControlButton(button, { active, icon, label }) {
  if (!button) {
    return;
  }

  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.classList.toggle("control-pill--active", active);

  const iconEl = button.querySelector(".icon");
  if (iconEl && icon) {
    iconEl.className = `icon ${icon}`;
  }

  const labelEl = button.querySelector(".control-pill__label");
  if (labelEl && label) {
    labelEl.textContent = label;
  }
}

function setReceiverStatus(text) {
  if (!app.dom.receiverStatus) {
    return;
  }

  app.dom.receiverStatus.hidden = !text;
  app.dom.receiverStatus.textContent = text || "";
}

function showError(message) {
  if (app.dom.errorMessage) {
    app.dom.errorMessage.textContent = message;
  }
  setStep("error");
}

function capitalize(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatError(error) {
  return error?.message || error?.body?.message || String(error);
}
