# Kerala Battle — Beta Test Checklist (Task 11)

Real-device manual testing. Mark each item PASS / FAIL with device + date.
Items that could not be tested in this environment are marked **UNVERIFIED**
— they must be tested with real credentials/devices before the public beta.

## Devices

| # | Device | OS / browser | Tester | Date |
|---|--------|--------------|--------|------|
| 1 | Android phone | Chrome | | |
| 2 | iPhone | Safari | | |
| 3 | Desktop | Chrome / Safari | | |

## 1. Onboarding & auth

- [ ] Google login works on Android Chrome **(UNVERIFIED — no real Google OAuth client configured in test env)**
- [ ] Google login works on iPhone Safari **(UNVERIFIED)**
- [ ] New account completes name + district onboarding
- [ ] Returning account keeps stable identity (same playerId, history intact)
- [ ] Guest profile claim: guest progress carries into the Google account
- [ ] Sign out → sign in again works
- [ ] Banned/suspended account sees "This account is unavailable"

## 2. Social lobby

- [ ] Movement is smooth on Android Chrome **(UNVERIFIED on real device)**
- [ ] Virtual joystick usable on small screens **(UNVERIFIED)**
- [ ] Other players' avatars appear and move
- [ ] District population count updates live
- [ ] Change district works; contributions stay historically attributed
- [ ] Disconnect → reconnect rejoins cleanly

## 3. Voice (requires real LiveKit credentials + TWO physical phones)

All items below are **UNVERIFIED** — no LiveKit credentials or second device
were available during Task 11.

- [ ] Both phones join the same district; voice connects on both
- [ ] Near avatars: clear audio both directions
- [ ] Walk avatars apart: volume fades with distance
- [ ] Beyond max range: silence
- [ ] Walk back together: audio returns
- [ ] Mic mute works; deafen works
- [ ] Blocking a voice user silences them (blocker side)
- [ ] Switching district leaves the old voice room
- [ ] Match start leaves district voice on both phones
- [ ] Voice permission prompt behaves sanely on iPhone Safari

## 4. Games

- [ ] Precision Clash: 3 rounds, scoring, result screen **(UNVERIFIED on real device)**
- [ ] Crown Rush: movement, crown capture, sudden death **(UNVERIFIED on real device)**
- [ ] Rematch flow works for both games
- [ ] Opponent disconnect mid-match notifies cleanly; no ranked points

## 5. Weekly ranked battle

- [ ] Join Weekly Battle → match found vs another district **(UNVERIFIED end-to-end on devices)**
- [ ] Ranked result settles points; district leaderboard updates
- [ ] Rematch after ranked stays casual (0 points)
- [ ] Weekly Master / District Champion history renders

## 6. Safety

- [ ] Block a player: challenges blocked both ways, voice silenced
- [ ] Unblock restores
- [ ] Report dialog submits (all 6 reasons); duplicate/rate-limit handled
- [ ] Blocked avatar shows subtle "Blocked" state; no notification to them

## 7. Mobile specifics (UNVERIFIED — no real devices in test env)

- [ ] Joystick smoothness under load
- [ ] Crown Rush responsiveness
- [ ] Battery/heat qualitatively acceptable (no lab measurements claimed)
- [ ] Voice + game simultaneously
- [ ] Viewport safe areas (notch/Dynamic Island)
- [ ] Keyboard/modal overlap on profile editing
- [ ] Portrait/landscape orientation behavior
- [ ] Background/foreground app switch reconnects
- [ ] Network switch Wi-Fi → mobile data reconnects

## 8. Error states

- [ ] Server unreachable: reconnect UI, no stack traces
- [ ] `MAINTENANCE_MODE=true`: maintenance notice, no new games/queues
- [ ] Server restart: "restarting" notice, auto-reconnect
- [ ] Voice unavailable: clean disabled state, game still works
- [ ] Google auth unavailable: clear message, no crash

## How to run

1. Deploy per `DEPLOYMENT.md` with real Google + LiveKit credentials.
2. Two testers, two phones, same district for voice tests.
3. Walk through each section; record PASS/FAIL + device + date.
4. File bugs with: device, OS/browser, steps, `x-request-id` response header
   value if available (correlates with server logs), and a timestamp.
