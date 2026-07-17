import Http from "./http.js";

/**
 * Thin wrapper around the Webex REST APIs used by the client web app.
 *
 * This is only used to read profile information and to list the signed-in
 * user's scheduled / in-progress meetings so they can be presented for joining.
 * The actual audio/video join is handled by the Webex Web SDK (see meetings.js).
 */
class Webex {
  #http;

  /**
   * @param {string} accessToken - Required OAuth access token.
   * @param {?string} baseUrl - Webex REST base URL (may include a /v1 suffix).
   */
  constructor(accessToken, baseUrl = "https://webexapis.com/v1") {
    if (
      !accessToken ||
      typeof accessToken !== "string" ||
      !accessToken.trim()
    ) {
      throw new Error("Access token is required");
    }

    if (!baseUrl || typeof baseUrl !== "string" || !baseUrl.trim()) {
      throw new Error("Base URL is required");
    }

    this.#http = new Http(accessToken, baseUrl);
  }

  /**
   * Get the profile of the person the access token belongs to.
   * @returns {Promise<object>} Webex person record.
   */
  async getMe() {
    return this.#http.getJson("/people/me");
  }

  /**
   * List meetings for the signed-in user.
   *
   * By default this returns scheduled and in-progress meetings so the user can
   * pick one to join. Webex returns meetings via a paginated `items` array.
   *
   * @param {object} [params]
   * @param {?string} params.meetingType - "meetingSeries" | "scheduledMeeting" | "meeting".
   * @param {?string} params.state - Filter by state, e.g. "active" | "scheduled" | "inProgress".
   * @param {?string} params.from - ISO8601 lower bound for the meeting start time.
   * @param {?string} params.to - ISO8601 upper bound for the meeting start time.
   * @param {?number} params.max - Maximum number of meetings to return per page.
   * @returns {Promise<object[]>} Array of Webex meeting records.
   */
  async listMeetings(params = {}) {
    const query = {
      meetingType: "scheduledMeeting",
      max: 50,
      ...params,
    };

    return this.#http.getPaginated("/meetings", query);
  }

  /**
   * Fetch a single meeting by id.
   * @param {string} meetingId - Webex meeting id.
   * @returns {Promise<object>} Webex meeting record.
   */
  async getMeeting(meetingId) {
    if (!meetingId) {
      throw new Error("meetingId is required");
    }

    return this.#http.getJson(`/meetings/${encodeURIComponent(meetingId)}`);
  }
}

export default Webex;
