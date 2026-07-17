/**
 * Custom Chromecast Web Receiver for Webex meetings.
 *
 * The receiver listens on a custom Cast namespace for join instructions sent by
 * the sender web app, then uses the Webex Web SDK to join the same meeting in
 * receive-only mode and render the remote video, audio, and presentation share
 * on the TV.
 *
 * Loaded as a classic script: `cast` (CAF) and `Webex` (UMD) are globals.
 */
(function () {
  "use strict";

  var CAST_NAMESPACE = "urn:x-cast:com.cisco.wxsd.webex-chromecast";

  var MESSAGE_TYPES = {
    JOIN_MEETING: "JOIN_MEETING",
    LEAVE_MEETING: "LEAVE_MEETING",
    STATUS: "STATUS",
  };

  var elements = {
    remoteVideo: document.getElementById("remoteVideo"),
    remoteShare: document.getElementById("remoteShare"),
    remoteAudio: document.getElementById("remoteAudio"),
    overlay: document.getElementById("overlay"),
    overlayTitle: document.getElementById("overlayTitle"),
    overlayStatus: document.getElementById("overlayStatus"),
    overlaySpinner: document.getElementById("overlaySpinner"),
  };

  var webex = null;
  var meeting = null;
  var joining = false;

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
      });
    } catch (error) {
      // Sending status is best-effort.
      console.warn("Failed to send status to sender:", error);
    }
  }

  /* -------------------------------------------------------- Meeting --- */

  function attachMediaListeners() {
    if (!meeting) {
      return;
    }

    meeting.on("media:ready", function (media) {
      if (!media || !media.stream) {
        return;
      }

      if (media.type === "remoteVideo") {
        elements.remoteVideo.srcObject = media.stream;
        showOverlay(false);
      } else if (media.type === "remoteAudio") {
        elements.remoteAudio.srcObject = media.stream;
      } else if (media.type === "remoteShare") {
        elements.remoteShare.srcObject = media.stream;
        elements.remoteShare.hidden = false;
        showOverlay(false);
      }
    });

    meeting.on("media:stopped", function (media) {
      if (media && media.type === "remoteShare") {
        elements.remoteShare.hidden = true;
        elements.remoteShare.srcObject = null;
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
    [elements.remoteVideo, elements.remoteShare, elements.remoteAudio].forEach(
      function (el) {
        if (el) {
          el.srcObject = null;
        }
      },
    );
    if (elements.remoteShare) {
      elements.remoteShare.hidden = true;
    }
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
        return webex.meetings.register();
      })
      .then(function () {
        return webex.meetings.create(destination);
      })
      .then(function (createdMeeting) {
        meeting = createdMeeting;
        attachMediaListeners();
        return meeting.join({ enableMultistream: false });
      })
      .then(function () {
        // Receive-only: the receiver never sends camera/microphone media.
        return meeting.addMedia({
          audioEnabled: false,
          videoEnabled: false,
          shareVideoEnabled: true,
          allowMediaInLobby: true,
          additionalMediaOptions: {
            sendAudio: false,
            sendVideo: false,
            receiveAudio: true,
            receiveVideo: true,
          },
        });
      })
      .then(function () {
        joining = false;
        setStatus("Connected");
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

  setStatus("Ready to cast");
  context.start(options);
})();
