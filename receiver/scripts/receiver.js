/**
 * Custom Chromecast Web Receiver for Webex meetings.
 *
 * The receiver listens on a custom Cast namespace for instructions sent by the
 * sender web app, then uses the Webex Web SDK to join the same meeting in
 * receive-only mode and render the remote video, audio, and presentation share
 * on the TV.
 *
 * Two media modes are supported:
 *  - standard (transcoded): Webex composes one video (remoteVideo) plus a
 *    separate presentation (remoteShare). The participants arrangement is set
 *    with meeting.changeVideoLayout().
 *  - multistream: one stream per participant (the Webex RemoteMediaManager),
 *    shown as tiles / a filmstrip. Falls back to standard mode if it fails.
 *
 * The on-screen arrangement (presentation layout, pip corner, participants
 * view) and the audio output are driven by a "view" object from the sender.
 *
 * Loaded as a classic script: `cast` (CAF) and `Webex` (UMD) are globals.
 */
(function () {
  "use strict";

  var CAST_NAMESPACE = "urn:x-cast:com.cisco.wxsd.webex-chromecast";

  var MESSAGE_TYPES = {
    JOIN_MEETING: "JOIN_MEETING",
    LEAVE_MEETING: "LEAVE_MEETING",
    SET_VIEW: "SET_VIEW",
    STATUS: "STATUS",
  };

  /** Participants view -> Webex server layout (standard mode). */
  var SERVER_LAYOUTS = {
    speaker: "Single",
    grid: "Equal",
    prominent: "Prominent",
  };

  /** Participants view -> multistream layout id (when no presentation). */
  var MULTISTREAM_LAYOUT_IDS = {
    speaker: "Single",
    grid: "AllEqual",
    prominent: "OnePlusFive",
  };

  var MULTISTREAM_LAYOUTS = {
    Single: {
      activeSpeakerVideoPaneGroups: [
        { id: "main", numPanes: 1, size: "best", priority: 255 },
      ],
    },
    AllEqual: {
      activeSpeakerVideoPaneGroups: [
        { id: "main", numPanes: 9, size: "best", priority: 255 },
      ],
    },
    OnePlusFive: {
      activeSpeakerVideoPaneGroups: [
        { id: "big", numPanes: 1, size: "large", priority: 255 },
        { id: "small", numPanes: 5, size: "very small", priority: 254 },
      ],
    },
    // Presentation with the active speaker (pip / presentation only).
    ShareSpeaker: {
      screenShareVideo: { size: "best" },
      activeSpeakerVideoPaneGroups: [
        { id: "speaker", numPanes: 1, size: "small", priority: 255 },
      ],
    },
    // Presentation with a filmstrip of participants above it.
    ShareFilmstrip: {
      screenShareVideo: { size: "best" },
      activeSpeakerVideoPaneGroups: [
        { id: "thumbnails", numPanes: 6, size: "thumbnail", priority: 255 },
      ],
    },
  };

  var MEDIA_POLL_MS = 1000;
  var MEDIA_POLL_MAX = 20;
  var READY_TIMEOUT_MS = 30000;

  var elements = {
    stage: document.getElementById("stage"),
    remoteVideo: document.getElementById("remoteVideo"),
    remoteShare: document.getElementById("remoteShare"),
    remoteAudio: document.getElementById("remoteAudio"),
    tiles: document.getElementById("tiles"),
    audioSinks: document.getElementById("audioSinks"),
    overlay: document.getElementById("overlay"),
    overlayTitle: document.getElementById("overlayTitle"),
    overlayStatus: document.getElementById("overlayStatus"),
    overlaySpinner: document.getElementById("overlaySpinner"),
  };

  var view = {
    presentation: "pip",
    pipPosition: "bottom-right",
    participants: "speaker",
    audioOutput: "receiver",
  };

  var webex = null;
  var meeting = null;
  var joining = false;
  var multistream = false;
  var hasShare = false;

  // Multistream bookkeeping.
  var tiles = []; // { media, el, onUpdate }
  var audioSinks = []; // { media, el, onUpdate }
  var shareMedia = null;
  var shareOnUpdate = null;
  var pollTimer = null;
  var pollCount = 0;

  var context = cast.framework.CastReceiverContext.getInstance();

  /* ------------------------------------------------------------- UI --- */

  function setStatus(text, options) {
    options = options || {};
    if (elements.overlayStatus) {
      elements.overlayStatus.textContent = text;
    }
    if (elements.overlaySpinner) {
      elements.overlaySpinner.hidden = !options.busy;
    }
  }

  function setTitle(title) {
    if (elements.overlayTitle && title) {
      elements.overlayTitle.textContent = title;
    }
  }

  function showOverlay(show) {
    if (elements.overlay) {
      elements.overlay.hidden = !show;
    }
  }

  function broadcastStatus(state, message) {
    try {
      context.sendCustomMessage(CAST_NAMESPACE, undefined, {
        type: MESSAGE_TYPES.STATUS,
        state: state,
        message: message || state,
        view: view,
        hasShare: hasShare,
        multistream: multistream,
      });
    } catch (error) {
      // Sending status is best-effort.
      console.warn("Failed to send status to sender:", error);
    }
  }

  /* ----------------------------------------------------------- View --- */

  function mergeView(next) {
    if (!next) {
      return;
    }
    ["presentation", "pipPosition", "participants", "audioOutput"].forEach(
      function (key) {
        if (typeof next[key] === "string" && next[key]) {
          view[key] = next[key];
        }
      },
    );
  }

  /** Reflect `view` and share state onto the stage (CSS does the layout). */
  function applyView() {
    var stage = elements.stage;
    stage.dataset.presentation = view.presentation;
    stage.dataset.pip = view.pipPosition;
    stage.dataset.participants = view.participants;
    stage.dataset.hasShare = String(hasShare);
    stage.dataset.multistream = String(multistream);

    if (elements.remoteShare) {
      elements.remoteShare.hidden = !hasShare;
    }

    applyAudioOutput();
    layoutTiles();
    applyParticipantsLayout();
  }

  /** Mute the receiver's audio when the sender plays it instead. */
  function applyAudioOutput() {
    var muted = view.audioOutput !== "receiver";
    elements.remoteAudio.muted = muted;
    audioSinks.forEach(function (sink) {
      sink.el.muted = muted;
    });
  }

  /** Tell Webex how to arrange the participants. */
  function applyParticipantsLayout() {
    if (!meeting) {
      return;
    }

    if (multistream) {
      ensureMultistreamLayout();
      return;
    }

    var layout = SERVER_LAYOUTS[view.participants];
    if (!layout || !meeting.changeVideoLayout) {
      return;
    }

    meeting.changeVideoLayout(layout).catch(function (error) {
      // Rejects until video is flowing; applied again when media is ready.
      console.warn("changeVideoLayout(" + layout + ") failed:", error);
    });
  }

  function setHasShare(value) {
    value = Boolean(value);
    if (value === hasShare) {
      return;
    }
    hasShare = value;
    applyView();
    broadcastStatus("media", value ? "Presentation started" : "Presentation ended");
  }

  /* ---------------------------------------------------- Multistream --- */

  function desiredMultistreamLayoutId() {
    if (hasShare) {
      return view.presentation === "top" ? "ShareFilmstrip" : "ShareSpeaker";
    }
    return MULTISTREAM_LAYOUT_IDS[view.participants] || "AllEqual";
  }

  function buildRemoteMediaManagerConfig() {
    return {
      audio: { numOfActiveSpeakerStreams: 3, numOfScreenShareStreams: 1 },
      video: {
        preferLiveVideo: true,
        initialLayoutId: desiredMultistreamLayoutId(),
        layouts: MULTISTREAM_LAYOUTS,
      },
    };
  }

  function ensureMultistreamLayout() {
    var manager = meeting && meeting.remoteMediaManager;
    if (!manager) {
      return;
    }

    var wanted = desiredMultistreamLayoutId();
    if (manager.getLayoutId() === wanted) {
      return;
    }

    manager.setLayout(wanted).catch(function (error) {
      console.warn("setLayout(" + wanted + ") failed:", error);
    });
  }

  function streamOf(media) {
    var stream = media && media.stream;
    return stream ? stream.outputStream || stream : null;
  }

  function isLive(media) {
    return Boolean(media) && media.sourceState === "live" && Boolean(streamOf(media));
  }

  /** Re-check streams that weren't available when the layout event fired. */
  function startMediaPoll() {
    pollCount = 0;
    if (pollTimer) {
      return;
    }
    pollTimer = setInterval(function () {
      pollCount += 1;
      refreshAllMedia();
      if (pollCount >= MEDIA_POLL_MAX) {
        stopMediaPoll();
      }
    }, MEDIA_POLL_MS);
  }

  function stopMediaPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function refreshAllMedia() {
    tiles.forEach(updateTile);
    audioSinks.forEach(updateAudioSink);
    updateShare();
    layoutTiles();
  }

  function updateTile(tile) {
    var stream = streamOf(tile.media);
    if (stream && tile.el.srcObject !== stream) {
      tile.el.srcObject = stream;
    }
    tile.el.hidden = !isLive(tile.media);
  }

  /** Grid dimensions for the visible tiles. */
  function layoutTiles() {
    var visible = tiles.filter(function (tile) {
      return !tile.el.hidden;
    }).length;
    var cols = Math.max(1, Math.ceil(Math.sqrt(visible)));
    var rows = Math.max(1, Math.ceil(visible / cols));
    elements.tiles.style.setProperty("--cols", String(cols));
    elements.tiles.style.setProperty("--rows", String(rows));
  }

  function bindMedia(media, onUpdate) {
    if (media && typeof media.on === "function") {
      media.on("sourceUpdate", onUpdate);
    }
  }

  function unbindMedia(media, onUpdate) {
    if (media && typeof media.off === "function") {
      media.off("sourceUpdate", onUpdate);
    }
  }

  function renderVideoLayout(payload) {
    var medias = [];

    Object.keys((payload && payload.activeSpeakerVideoPanes) || {}).forEach(
      function (id) {
        medias = medias.concat(
          payload.activeSpeakerVideoPanes[id].getRemoteMedia(),
        );
      },
    );
    Object.keys((payload && payload.memberVideoPanes) || {}).forEach(function (id) {
      medias.push(payload.memberVideoPanes[id]);
    });

    // Drop tiles for streams that are no longer in the layout.
    tiles = tiles.filter(function (tile) {
      if (medias.indexOf(tile.media) !== -1) {
        return true;
      }
      unbindMedia(tile.media, tile.onUpdate);
      tile.el.srcObject = null;
      tile.el.remove();
      return false;
    });

    // Add tiles for new streams, keeping the layout's order.
    medias.forEach(function (media, index) {
      var existing = tiles.filter(function (tile) {
        return tile.media === media;
      })[0];

      if (!existing) {
        var el = document.createElement("video");
        el.className = "tile";
        el.autoplay = true;
        el.muted = true; // audio comes from the dedicated audio streams
        el.setAttribute("playsinline", "");
        el.hidden = true;

        existing = { media: media, el: el, onUpdate: null };
        existing.onUpdate = function () {
          updateTile(existing);
          layoutTiles();
        };
        bindMedia(media, existing.onUpdate);
        tiles.push(existing);
      }

      // Keep DOM order equal to layout order.
      elements.tiles.insertBefore(
        existing.el,
        elements.tiles.children[index] || null,
      );
    });

    bindShare(payload && payload.screenShareVideo);
    refreshAllMedia();
    startMediaPoll();
  }

  function bindShare(media) {
    if (media === shareMedia) {
      return;
    }
    if (shareMedia) {
      unbindMedia(shareMedia, shareOnUpdate);
    }
    shareMedia = media || null;
    shareOnUpdate = function () {
      updateShare();
    };
    if (shareMedia) {
      bindMedia(shareMedia, shareOnUpdate);
    }
    updateShare();
  }

  function updateShare() {
    if (!multistream) {
      return;
    }
    var live = isLive(shareMedia);
    if (live && elements.remoteShare.srcObject !== streamOf(shareMedia)) {
      elements.remoteShare.srcObject = streamOf(shareMedia);
    }
    if (!live) {
      elements.remoteShare.srcObject = null;
    }
    setHasShare(live);
  }

  function updateAudioSink(sink) {
    var stream = streamOf(sink.media);
    if (stream && sink.el.srcObject !== stream) {
      sink.el.srcObject = stream;
    }
  }

  function bindAudioMedia(media) {
    var el = document.createElement("audio");
    el.autoplay = true;
    el.muted = view.audioOutput !== "receiver";
    elements.audioSinks.appendChild(el);

    var sink = { media: media, el: el, onUpdate: null };
    sink.onUpdate = function () {
      updateAudioSink(sink);
    };
    bindMedia(media, sink.onUpdate);
    audioSinks.push(sink);
    updateAudioSink(sink);
    startMediaPoll();
  }

  function clearMultistream() {
    stopMediaPoll();
    tiles.forEach(function (tile) {
      unbindMedia(tile.media, tile.onUpdate);
      tile.el.srcObject = null;
      tile.el.remove();
    });
    tiles = [];
    audioSinks.forEach(function (sink) {
      unbindMedia(sink.media, sink.onUpdate);
      sink.el.srcObject = null;
      sink.el.remove();
    });
    audioSinks = [];
    if (shareMedia) {
      unbindMedia(shareMedia, shareOnUpdate);
    }
    shareMedia = null;
    shareOnUpdate = null;
  }

  /* -------------------------------------------------------- Meeting --- */

  function attachMediaListeners() {
    if (!meeting) {
      return;
    }

    // Standard (transcoded) mode.
    meeting.on("media:ready", function (media) {
      if (multistream || !media || !media.stream) {
        return;
      }

      if (media.type === "remoteVideo") {
        elements.remoteVideo.srcObject = media.stream;
        showOverlay(false);
        applyParticipantsLayout();
      } else if (media.type === "remoteAudio") {
        elements.remoteAudio.srcObject = media.stream;
      } else if (media.type === "remoteShare") {
        elements.remoteShare.srcObject = media.stream;
        setHasShare(true);
        showOverlay(false);
      }
    });

    meeting.on("media:stopped", function (media) {
      if (multistream) {
        return;
      }
      if (media && media.type === "remoteShare") {
        elements.remoteShare.srcObject = null;
        setHasShare(false);
      }
    });

    // Multistream mode.
    meeting.on("media:remoteVideo:layoutChanged", function (payload) {
      if (!multistream) {
        return;
      }
      showOverlay(false);
      renderVideoLayout(payload);
    });

    meeting.on("media:remoteAudio:created", function (group) {
      if (!multistream || !group) {
        return;
      }
      group.getRemoteMedia().forEach(bindAudioMedia);
    });

    meeting.on("media:remoteScreenShareAudio:created", function (media) {
      if (multistream && media) {
        bindAudioMedia(media);
      }
    });

    meeting.on("meeting:ended", function () {
      setStatus("Meeting ended");
      resetMedia();
      showOverlay(true);
    });

    meeting.on("meeting:self:lobbyWaiting", function () {
      setStatus("Waiting to be admitted…", { busy: true });
    });
  }

  function resetMedia() {
    clearMultistream();
    [elements.remoteVideo, elements.remoteShare, elements.remoteAudio].forEach(
      function (el) {
        if (el) {
          el.srcObject = null;
        }
      },
    );
    hasShare = false;
    applyView();
  }

  function waitForWebexReady(instance) {
    if (instance.ready) {
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error("Webex SDK did not become ready (check token/scopes)"));
      }, READY_TIMEOUT_MS);
      instance.once("ready", function () {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Create, join and add media to the meeting. Receive-only: the receiver
   * never sends camera/microphone media.
   *
   * NOTE: in SDK 3.x, audioEnabled/videoEnabled=false also turns off
   * *receiving* audio/video, so they stay true and sending is switched off
   * with additionalMediaOptions instead.
   */
  function joinOnce(destination, useMultistream) {
    multistream = useMultistream;
    applyView();

    return webex.meetings
      .create(destination)
      .then(function (createdMeeting) {
        meeting = createdMeeting;
        attachMediaListeners();
        return meeting.join({ enableMultistream: useMultistream });
      })
      .then(function () {
        var options = {
          audioEnabled: true,
          videoEnabled: true,
          shareVideoEnabled: true,
          allowMediaInLobby: true,
          additionalMediaOptions: {
            sendAudio: false,
            sendVideo: false,
            receiveAudio: true,
            receiveVideo: true,
          },
        };
        if (useMultistream) {
          options.remoteMediaManagerConfig = buildRemoteMediaManagerConfig();
        }
        return meeting.addMedia(options);
      });
  }

  function joinMeeting(payload) {
    if (joining) {
      return;
    }

    var destination = payload && payload.destination;
    var accessToken = payload && payload.accessToken;

    if (!destination || !accessToken) {
      setStatus("Missing meeting details from sender");
      broadcastStatus("error", "Missing meeting details");
      return;
    }

    if (!window.Webex) {
      setStatus("Webex SDK failed to load");
      broadcastStatus("error", "Webex SDK unavailable");
      return;
    }

    mergeView(payload.view);
    var wantMultistream = Boolean(payload.multistream);

    joining = true;
    setTitle(payload.title || "Webex meeting");
    setStatus("Joining meeting…", { busy: true });
    showOverlay(true);
    broadcastStatus("joining", "Joining meeting");

    leaveMeeting(true)
      .then(function () {
        webex = window.Webex.init({
          credentials: { access_token: accessToken },
        });
        // The SDK only finishes wiring up internally on `ready`; registering
        // earlier throws a misleading "reading 'internal'" TypeError.
        return waitForWebexReady(webex);
      })
      .then(function () {
        return webex.meetings.register();
      })
      .then(function () {
        return joinOnce(destination, wantMultistream).catch(function (error) {
          if (!wantMultistream) {
            throw error;
          }
          // Multistream isn't available for this meeting/device: fall back.
          console.warn("Multistream join failed, using standard mode:", error);
          broadcastStatus("warning", "Multistream unavailable, using standard video");
          return leaveMeeting(true).then(function () {
            return joinOnce(destination, false);
          });
        });
      })
      .then(function () {
        joining = false;
        setStatus("Connected");
        applyView();
        broadcastStatus("joined", "In meeting");
      })
      .catch(function (error) {
        joining = false;
        var message = (error && error.message) || String(error);
        console.error("Receiver join failed:", message);
        setStatus("Could not join: " + message);
        broadcastStatus("error", message);
      });
  }

  function leaveMeeting(silent) {
    if (!meeting) {
      return Promise.resolve();
    }

    var leaving = meeting.leave().catch(function (error) {
      console.warn("Leave failed:", error);
    });

    return leaving.then(function () {
      meeting = null;
      multistream = false;
      resetMedia();
      if (!silent) {
        setStatus("Ready to cast");
        showOverlay(true);
        broadcastStatus("left", "Left meeting");
      }
    });
  }

  /* ------------------------------------------------- Cast lifecycle --- */

  context.addCustomMessageListener(CAST_NAMESPACE, function (event) {
    var data = event.data;

    if (!data || !data.type) {
      return;
    }

    if (data.type === MESSAGE_TYPES.JOIN_MEETING) {
      joinMeeting(data);
    } else if (data.type === MESSAGE_TYPES.LEAVE_MEETING) {
      leaveMeeting(false);
    } else if (data.type === MESSAGE_TYPES.SET_VIEW) {
      mergeView(data.view);
      applyView();
      broadcastStatus("view", "Layout updated");
    }
  });

  context.addEventListener(
    cast.framework.system.EventType.SENDER_DISCONNECTED,
    function () {
      // When the last sender disconnects, CAF shuts the receiver down; leave the
      // meeting cleanly first.
      leaveMeeting(true);
    },
  );

  var options = new cast.framework.CastReceiverOptions();
  // This is not a standard media-playback receiver, so keep it alive without a
  // media session and declare our JSON custom namespace.
  options.disableIdleTimeout = true;
  options.customNamespaces = {};
  options.customNamespaces[CAST_NAMESPACE] =
    cast.framework.system.MessageType.JSON;

  applyView();
  setStatus("Ready to cast");
  context.start(options);
})();
