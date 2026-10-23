# Webex Chromecast

An example that lets a user join a Webex meeting from their browser and cast the
meeting's audio, video, and presentation share to a nearby Chromecast running a
custom Web Receiver.

## Overview

There are two web apps in this repo:

- **`/client`** – a Webex "sender" web app. The user signs in with Webex (OAuth
  implicit `token` flow via `oauth.js`), the app lists their scheduled and
  in-progress meetings through the Webex REST API, and joins the selected meeting
  in the browser using the [Webex Web SDK](https://developer.webex.com/meeting/docs/sdks/webex-meetings-sdk)
  with the browser microphone and camera. The [Google Cast Web Sender SDK](https://developers.google.com/cast/docs/web_sender)
  discovers nearby Chromecast devices; when the user casts, the app sends the
  meeting join instructions to the receiver over a custom Cast message channel.
- **`/receiver`** – a custom Chromecast [Web Receiver](https://developers.google.com/cast/docs/web_receiver).
  When it receives join instructions from the sender, it uses the Webex Web SDK
  to join the same meeting in receive-only mode and renders the remote video,
  audio, and presentation share full-screen on the TV.

The Momentum Design icons, tokens, and illustrations are used for styling in
both apps, and are loaded from CDN in each `index.html`.

### Diagrams

<details>

  <summary>Show Sequence Diagram</summary>
  
  ```mermaid
  sequenceDiagram
      actor User
      participant Browser as Browser <br>(client app)
      participant Webex
      participant Receiver as Chromecast <br>(receiver)

      User->>Browser: Open client app
      Browser->>Webex: Sign in (OAuth token flow)
      Webex-->>Browser: Access token
      Browser->>Webex: List meetings (REST)
      Webex-->>Browser: Scheduled / in-progress meetings

      User->>Browser: Join meeting
      Browser->>Webex: Join with mic + camera (Web SDK)
      Webex-->>Browser: Remote audio / video / share

      User->>Browser: Cast to Chromecast (Cast Sender SDK)
      Browser->>Receiver: JOIN_MEETING {destination, token} (urn:x-cast)
      Receiver->>Webex: Join same meeting, receive-only (Web SDK)
      Webex-->>Receiver: Remote audio / video / share
      Receiver-->>Browser: STATUS updates
      Receiver-->>User: Display meeting media on TV

````
</details>

## Setup

### Prerequisites & Dependencies

- Node.js 18+ (only used for the tiny static file server and dev proxy).
- A Webex account and a Webex OAuth integration configured for the implicit
`token` grant. The client id and redirect URI are configured in
`client/scripts/oauth.js`. The integration needs the `spark:all`, `spark:kms`,
and `meeting:schedules_read` scopes.
- A Google Cast application id for the custom receiver, registered in the
[Google Cast Developer Console](https://cast.google.com/publish). Set it in
`client/scripts/config.js` (`CHROMECAST_RECEIVER_APPLICATION_ID`). The receiver
must be hosted over HTTPS and registered with that URL.
- A Chromecast device on the same network for end-to-end testing.

### Installation Steps

1. Serve the **client** app locally:

 ```sh
 npm run serve
````

This serves `client/` at `http://127.0.0.1:4173`. Because the Webex REST API
does not send CORS headers, run the bundled proxy in a second terminal when
testing on localhost:

```sh
npm run proxy
```

2. Host the **receiver** app (`receiver/`) over HTTPS and register its URL in the
   Google Cast Developer Console under your application id. Add your test
   Chromecast as a registered device so it can load an unpublished receiver.

3. Open the client app, sign in with Webex, pick or enter a meeting, then use the
   Cast button to select your Chromecast and send the meeting to the TV.

4. While casting, the **Chromecast layout** panel in the client controls what the
   TV shows:
   - **When presenting:** presentation only, picture-in-picture (with a
     selectable corner), or participants on top with the presentation below.
   - **Participants view:** active speaker, grid, or speaker + others.
   - **Meeting audio plays on:** the Chromecast or the browser, with a volume
     slider (the Chromecast's device volume) and mute.
   - **Multistream (beta):** tick the option on the meetings screen before
     joining to get one video per participant (a filmstrip above a
     presentation). If multistream can't be set up the receiver falls back to
     standard video.

> **Security note:** for demo simplicity the receiver reuses the signed-in
> user's Webex access token (sent over the local Cast channel) to join the
> meeting. In production, mint a short-lived guest token for the receiver
> instead of forwarding the user's token, and never log tokens.

## Demo

Live GitHub Pages Demo: https://wxsd-sales.github.io/webex-chromecast/client

_For more demos & PoCs like this, check out our [Webex Labs site](https://collabtoolbox.cisco.com/webex-labs)._

## License

All contents are licensed under the MIT license. Please see [license](LICENSE) for details.

## Disclaimer

Everything included is for demo and Proof of Concept purposes only. Use of the site is solely at your own risk. This site may contain links to third party content, which we do not warrant, endorse, or assume liability for. These demos are for Cisco Webex usecases, but are not Official Cisco Webex Branded demos.

## Questions

Please contact the WXSD team at [wxsd@external.cisco.com](mailto:wxsd@external.cisco.com?subject=webex-chromecast) for questions. Or, if you're a Cisco internal employee, reach out to us on the Webex App via our bot (globalexpert@webex.bot). In the "Engagement Type" field, choose the "API/SDK Proof of Concept Integration Development" option to make sure you reach our team.
