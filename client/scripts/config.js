/**
 * Shared configuration for the Webex Chromecast client web app.
 */

/**
 * The published Cast application id for the custom Web Receiver in /receiver.
 * Register your receiver in the Google Cast Developer Console and replace this
 * value with your own application id. The receiver must be hosted over HTTPS.
 */
export const CHROMECAST_RECEIVER_APPLICATION_ID = "4103BEBF";

/**
 * Custom Cast message namespace used to exchange meeting-join instructions and
 * status updates between this sender app and the custom receiver. Cast requires
 * custom namespaces to start with "urn:x-cast:".
 */
export const CAST_NAMESPACE = "urn:x-cast:com.cisco.wxsd.webex-chromecast";

/**
 * Message types exchanged over CAST_NAMESPACE.
 */
export const CAST_MESSAGE_TYPES = {
  /** Sender -> receiver: join a meeting and display its media. */
  JOIN_MEETING: "JOIN_MEETING",
  /** Sender -> receiver: leave the current meeting. */
  LEAVE_MEETING: "LEAVE_MEETING",
  /** Receiver -> sender: status/lifecycle updates. */
  STATUS: "STATUS",
};
