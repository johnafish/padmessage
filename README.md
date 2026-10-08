# padmessage

Web messaging encrypted with one-time pads. Two people swap a pad file in person once, and every message after that is encrypted with fresh pad bytes that are never reused. The relay only ever sees ciphertext.

```sh
npm install
npm run dev        # relay on :8787, app on http://localhost:5173
npm test           # crypto tests (incl. RFC 8439 Poly1305 vector)
npm run build && npm start   # production: relay serves dist/ on :8787 with a strict CSP
```

Requires Node 22.13+ (uses the built-in `node:sqlite`).

## How it works

- **Pads never leave the device.** They're generated in the browser or loaded from a file, and stored in IndexedDB. "Load pad" reads the file locally. Nothing is uploaded.
- **Randomness is labelled honestly.** `crypto.getRandomValues` is a CSPRNG: very strong, but computational. A pad made only from it is not information-theoretically secure. Create a pad can XOR in hardware TRNG output (e.g. `/dev/hwrng`, Infinite Noise, OneRNG), which is at least as random as the better source. Only those pads are labelled **True random**. The source is recorded in the pad header (byte 9), so both copies show the same label. Raw files with no header are **Unverified**. Each hardware dump is fingerprinted (first 64 KiB) and can't be mixed into a second pad on the same device.
- **Camera noise** (`src/crypto/entropy.ts`, `src/ui/webcam.ts`). Create a pad can also XOR in conditioned webcam sensor noise. Frames are read at native resolution and never stored or sent. Per 4096-pixel chunk:
  1. Estimate min-entropy from the low 2 bits of the frame-to-frame green-channel difference (NIST SP 800-90B most-common-value estimator, skipping clipped pixels).
  2. Credit only 25% of that estimate.
  3. Condition with SHA-256 Hash_df, emitting at most half the credited bits.

  Frozen, covered, clipped or uniformly shifting images yield nothing, and Chrome's synthetic test camera yields nothing either. These pads are labelled **Camera noise**, not True random: a browser can't verify how much real noise a camera delivers (cameras denoise and compress, and a virtual camera can replay anything). The production server sends `Permissions-Policy: camera=(self)`.
- **Two halves, no collisions.** Side 0 (Sun) encrypts only with the first half of the pad and side 1 (Moon) only with the second. A generated pad marks the partner's copy as Moon in a 16-byte file header. Raw pads, e.g. from a hardware RNG, ask the user to choose a side.
- **Bytes are burned before use.** `reserve()` in `src/store.ts` advances the offset in an IndexedDB transaction, under a Web Lock, *before* encrypting. A failed send burns those bytes and a retry uses new ones. The offset also never drops below the highest offset the relay has seen for that side, which covers restored or stale devices.
- **Each message is authenticated.** Format: `[32-byte Poly1305 one-time key | keystream]` from the pad, XOR, then encrypt-then-MAC over chat id, side, offset and ciphertext. That's information-theoretic secrecy plus integrity. Plaintext is padded to 32-byte blocks.
- **Pad identity.** `chatId = H("chat" ‖ H(pad))` is the server-visible room id. `fingerprint = H("fp" ‖ H(pad))` is shown to both people for comparison. `writeKey = H("write" ‖ H(pad))` is claimed on the relay trust-on-first-use, so people who only have the link can't post junk at future offsets.
- **Collision detection.** If an authenticated message arrives from your own side that this device didn't send, sending pauses and a warning is shown.
- **The relay** (`server/index.ts`) stores ciphertext in SQLite, refuses overlapping pad ranges per side, rate-limits writes and fans out over WebSockets.

## Glass primitives

`src/styles/glass.css` defines the surface system. Each surface layers a translucent material, a gradient rim light, a pointer-tracked specular sheen and depth shadows. Variants: `.glass`, `--clear`, `--thick`, `--tinted`, `--pill`, `--interactive`, plus `.glass-well` for inputs. It respects `prefers-reduced-transparency`, `prefers-reduced-motion` and light/dark mode.

## Known limits / next steps

- One device per pad. A second device on the same side triggers the collision warning.
- No forward secrecy yet. Optionally zero used pad bytes and keep a local transcript.
- Web-delivered JS is still the trust anchor. Ship reproducible builds and SRI, and consider a PWA or offline client.
- Metadata (who talks when, approximate sizes) is visible to the relay.
- Pads are loaded fully into memory (max 512 MB).
