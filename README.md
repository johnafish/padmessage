# PadMessage

Web messaging encrypted with one-time pads. Two people swap a pad file in person once, and every message after that is encrypted with fresh pad bytes that are never reused. The relay only ever sees ciphertext.

```sh
npm install
npm run dev        # relay on :8787, app on http://localhost:5173
npm test           # crypto and relay tests (incl. RFC 8439 Poly1305 vector)
```

Requires Node 22.18+. To run it on a server, see [Self-hosting](#self-hosting).

## How it works

- **Pads never leave the device.** They're generated in the browser or loaded from a file, and stored in IndexedDB. "Load pad" reads the file locally. Nothing is uploaded.
- **Randomness is labelled honestly.** `crypto.getRandomValues` is a CSPRNG: very strong, but computational. A pad made only from it is not information-theoretically secure. Create a pad can XOR in hardware TRNG output (e.g. `/dev/hwrng`, Infinite Noise, OneRNG), which is at least as random as the better source. Only those pads are labelled **True random**. The source is recorded in the pad header (byte 9), so both copies show the same label. Raw files with no header are **Unverified**. Each hardware dump is fingerprinted (first 64 KiB) and can't be mixed into a second pad on the same device.
- **Camera noise** (`src/crypto/entropy.ts`, `src/ui/webcam.ts`). Create a pad can also XOR in conditioned webcam sensor noise. Frames are read at native resolution and never stored or sent. Per 4096-pixel chunk:
  1. Estimate min-entropy from the low 2 bits of the frame-to-frame green-channel difference (NIST SP 800-90B most-common-value estimator, skipping clipped pixels).
  2. Credit only 25% of that estimate.
  3. Condition with SHA-256 Hash_df, emitting at most half the credited bits.

  Frozen, covered, clipped or uniformly shifting images yield nothing, and Chrome's synthetic test camera yields nothing either. These pads are labelled **Camera noise**, not True random: a browser can't verify how much real noise a camera delivers (cameras denoise and compress, and a virtual camera can replay anything). The production server sends `Permissions-Policy: camera=(self)`.
- **Two halves, no collisions.** One person encrypts only with the first half of the pad and the other only with the second, so their messages can never use the same bytes, whatever the timing. A generated pad marks the partner's copy for the second half in a 16-byte file header. Raw pads, e.g. from a hardware RNG, ask the user which half is theirs.
- **Bytes are burned before use.** `reserve()` in `src/store.ts` advances the offset in an IndexedDB transaction, under a Web Lock, *before* encrypting. A failed send burns those bytes and a retry uses new ones. The offset also never drops below the highest offset the relay has seen for that side, which covers restored or stale devices.
- **Each message is authenticated.** Format: `[32-byte Poly1305 one-time key | keystream]` from the pad, XOR, then encrypt-then-MAC over chat id, side, offset and ciphertext. That's information-theoretic secrecy plus integrity. Plaintext is padded to 32-byte blocks.
- **Pad identity.** `chatId = H("chat" ‖ H(pad))` is the server-visible room id. `fingerprint = H("fp" ‖ H(pad))` is shown to both people for comparison. `writeKey = H("write" ‖ H(pad))` is claimed on the relay trust-on-first-use, so people who only have the link can't post junk at future offsets.
- **Photos.** Images are shrunk and re-encoded in the browser (WebP, or JPEG where WebP encoding isn't available) before sending, because every byte spends pad. The sender picks Small (640 px), Medium (1280 px) or Large (2048 px), each showing its exact pad cost. The default is the largest size that spends at most a quarter of what's left. Re-encoding through a canvas drops all metadata (EXIF location, camera, timestamps). A photo and its caption travel as one sealed message (`kind = 2` in `src/crypto/otp.ts`), up to 3 MB. Photos can be attached with the button, by pasting, or by dropping onto the chat.
- **Delivery status.** Your latest message shows *Sending…* until the relay confirms it, then *Delivered*. Delivered means stored on the relay: it only replies to a send after the database write. It does not mean your partner has opened it. A failed send shows *Not delivered* with a retry, which uses fresh pad bytes.
- **Conversation list.** Each chat shows its newest message and time, with an unread dot, as in iMessage. Previews are verified and decrypted on the fly from just that message's pad bytes, and held in memory only: no plaintext is ever stored. The read position is a single number per chat. Pads are stored as Blobs so a slice can be read without loading the whole pad. Changes reach every open tab through a `BroadcastChannel`.
- **Collision detection.** If an authenticated message arrives from your own side that this device didn't send, sending pauses and a warning is shown.
- **The relay** (`server/index.ts`) stores ciphertext in SQLite, refuses overlapping pad ranges per side, rate-limits writes and pushes new messages as Server-Sent Events. Each tab opens one stream (`/api/events?chats=…`) covering every chat on the device. Message sequence numbers are global, so one `Last-Event-ID` resumes all of them. Photo-sized messages travel on the stream as stubs, and a client fetches the body only when that chat is open. `/api/latest` gives the newest message per chat for previews.

## Self-hosting

PadMessage is one Node process and one SQLite file. It calls no third-party services, and the server has no npm dependencies: it runs on Node's built-in modules alone.

**You need:** a server with Node 22.18+ (or Docker), a domain name pointing at it, and **HTTPS**. Browsers only allow the cryptography PadMessage uses (WebCrypto, plus Web Locks and the camera) on HTTPS or `localhost`. Over plain HTTP the app shows an explanation instead of working, and the server warns at startup.

### Option A: Docker with automatic HTTPS

Caddy gets and renews a Let's Encrypt certificate for you.

1. Point your domain's DNS at the server and open ports 80 and 443.
2. In this directory:

   ```sh
   DOMAIN=chat.example.com docker compose up -d
   ```

Messages live in the `padmessage-data` volume. The image builds the app and runs the tests during the build. The final image contains only Node, `server/index.ts` and the built app, with no `node_modules`.

### Option B: Node directly

```sh
npm ci && npm run build   # build tools are only needed for this step
npm prune --omit=dev      # optional: removes them; the server needs none
```

Then serve it over HTTPS in one of two ways.

**With your own certificate.** The server speaks HTTPS and HTTP/2 itself:

```sh
TLS_CERT=/etc/letsencrypt/live/chat.example.com/fullchain.pem \
TLS_KEY=/etc/letsencrypt/live/chat.example.com/privkey.pem \
PORT=8443 npm start
```

It re-reads the certificate files on `SIGHUP` and twice a day, so renewals need no restart.

**Behind a reverse proxy** that handles HTTPS:

```sh
HOST=127.0.0.1 TRUST_PROXY=1 npm start
```

With Caddy, the whole site config is `chat.example.com { reverse_proxy 127.0.0.1:8787 }`. With nginx, enable `http2` on the HTTPS listener and use:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;      # live message stream
    proxy_read_timeout 1h;
}
```

### Option C: Railway

`railway.json` configures the build (this Dockerfile), the `/healthz` health check and a single replica. A single replica is required: the database is one SQLite file and live streams are held in memory.

1. Create a service from this repo and attach a **volume mounted at `/data`**. Without one, messages are lost on every deploy.
2. Set the variables `CLIENT_IP_HEADER=x-real-ip` and `RAILWAY_RUN_UID=0`. The second lets the image's non-root user write to the volume.
3. Add your domain (`railway domain chat.example.com`) and create the `CNAME` and `TXT` records it prints at your DNS provider. A subdomain needs no nameserver change.
4. Open `https://chat.example.com/api/client-ip`. It should show your own public address. If it shows a `100.64.x.x` address, Railway's header isn't the client's: try `CLIENT_IP_HEADER=x-forwarded-for`.

Railway's edge caps request duration, so the server ends each live stream every 4 minutes (`STREAM_MAX_SECONDS`). Browsers reconnect within a second and replay anything they missed.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on. |
| `HOST` | all interfaces | Set `127.0.0.1` when a proxy on the same machine is the only client. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. |
| `DIST_DIR` | `./dist` | The built app. |
| `TLS_CERT`, `TLS_KEY` | unset | Certificate and key paths. Set both to serve HTTPS and HTTP/2 directly. |
| `TRUST_PROXY` | off | `1` behind one reverse proxy that appends to `X-Forwarded-For` (nginx, Caddy): rate limits use its last entry, and HSTS is sent when the proxy reports HTTPS. |
| `CLIENT_IP_HEADER` | unset | Behind a platform edge that overwrites a client-address header (Railway: `x-real-ip`): rate limits use that header's first value. Check it at `/api/client-ip`. |
| `STREAM_MAX_SECONDS` | `240` | How long a live stream stays open before the server ends it and the browser resumes. Keeps streams under proxies' request-duration caps. `0` disables. |
| `NODE_ENV` | unset | `production` serves the app. Otherwise the server is API-only and Vite serves the app in development. |

### Operations

- **Health check:** `GET /healthz` returns `ok`. The Docker image and `railway.json` use it.
- **Proxy check:** `GET /api/client-ip` shows the address the server attributes your requests to, which rate limiting uses.
- **Backups:** copy `DATA_DIR`. To copy safely while running, use `sqlite3 padmessage.sqlite ".backup backup.sqlite"`.
- **What the server stores:** ciphertext with its size and arrival time, chat IDs, and write-key hashes. Chat IDs and write keys are derived from the pad by hashing, so neither reveals it. The server never sees pads or plaintext, and there are no accounts. Client addresses are only held in memory, for rate limiting.
- **Shutdown:** `SIGTERM` closes open streams and the database cleanly. Browsers reconnect when the server is back.

### Dependencies

- **Runtime:** none beyond Node's built-in `http`, `http2`, `sqlite` and `crypto`. The `dependencies` list in `package.json` is empty, so a production install installs nothing.
- **Build:** Vite and TypeScript, plus `@noble/ciphers` (an audited Poly1305 implementation), which is compiled into the browser bundle. Tests use Vitest.
- **Optional:** the Docker setup uses the `node:24-alpine` and `caddy:2` images.

## Glass primitives

`src/styles/glass.css` defines the surface system. Each surface layers a translucent material, a gradient rim light, a pointer-tracked specular sheen and depth shadows. Variants: `.glass`, `--clear`, `--thick`, `--tinted`, `--pill`, `--interactive`, plus `.glass-well` for inputs. It respects `prefers-reduced-transparency`, `prefers-reduced-motion` and light/dark mode.

## Known limits / next steps

- One device per pad. Two devices holding the same half can't coordinate: if both send at once, the relay keeps only one message and the collision warning fires, but the relay has seen both ciphertexts under the same pad bytes. Proper multi-device support would split the remaining half between devices offline when copying the pad.
- No forward secrecy yet. Optionally zero used pad bytes and keep a local transcript.
- Web-delivered JS is still the trust anchor. Ship reproducible builds and SRI, and consider a PWA or offline client.
- Metadata (who talks when, approximate sizes) is visible to the relay. Since one stream follows all of a device's chats, the relay can also tell those chats belong to the same device (it could largely infer this from IP addresses anyway).
- Pads are loaded fully into memory (max 512 MB).
