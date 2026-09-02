# Known limitations

Written so that nobody has to discover these the hard way. Every item here is a
real property of the system as built, not a hypothetical.

---

## 1. The HTTP preview is not a secure deployment

The preview runs on a bare IP over plain HTTP. An attacker on the network path
can replace the JavaScript that performs the encryption. If they do, they see
plaintext before any cryptography happens, and nothing in the design prevents
it.

Use test data only. Production requires HTTPS, and the application refuses to
boot in `APP_MODE=production` on a non-HTTPS `PUBLIC_BASE_URL` unless
`ALLOW_INSECURE_PREVIEW=true` is set deliberately.

HTTPS narrows this to trusting the operator; it does not remove the class.

## 2. Browser-delivered cryptography trusts the server

Even over HTTPS, the server ships the code that encrypts. A compromised or
malicious server can serve a build that leaks. This is inherent to every
web-based end-to-end encryption product. Mitigations that would help
(Subresource Integrity on a static bundle, reproducible builds, a signed
extension) are on the roadmap and are **not implemented**.

## 3. Screenshots and copies cannot be prevented

The privacy curtain blurs content on screen and can auto-hide on tab blur. It
cannot stop an operating-system screenshot, a screen recording, a photograph
taken with a second device, or a recipient who simply pastes the content
elsewhere. The UI says so where the feature appears.

## 4. Memory zeroing is best effort

`sodium.memzero` clears the buffer it is given. JavaScript provides no way to
reach copies the engine may have made: interned strings, buffers relocated by
the garbage collector, JIT spill slots. Treat "the key was wiped" as *reduced
exposure*, never as *the key is gone*.

## 5. Weak passwords remain weak

A password-protected link carries the wrapped key in its fragment. Anyone who
intercepts the link can attack the password offline, at their own pace, with no
rate limit we can impose. Argon2id (ops 4, 64 MiB, ~0.66 s per guess) raises the
cost per attempt; a dictionary word is still a dictionary word.

## 6. Deletion is logical and cryptographic, not physical

When a capsule is destroyed we delete its rows and unlink its blob files. We do
not control, and therefore do not promise anything about:

- SSD wear-levelling and remapped sectors,
- filesystem journals,
- hypervisor or provider snapshots,
- any backup taken between creation and deletion.

## 7. Metadata is reduced, not eliminated

The server necessarily observes the IP address at the network layer while
answering a request. It is not stored — rate limiting keys on
`HMAC(rotating secret, IP)` — but "we never see your IP" would be false, so we
do not say it. Timing and approximate size remain observable to anyone watching
the network. "Zero metadata" is not a claim this project makes.

## 8. Not audited

No external cryptographic audit has taken place. The code uses standard
libsodium primitives and has 135 automated tests covering the security
properties, which is evidence — not assurance.

## 9. Large files on mobile browsers

Files are encrypted in 1 MiB chunks and never held whole in memory, but browser
behaviour still varies: iOS Safari may discard a background tab mid-upload, and
some mobile browsers cap total memory well below desktop. The 50 MiB per-file
preview limit is conservative for this reason. Resume is supported at chunk
granularity via the upload session's received-index list; a discarded tab must
be re-driven by the user.

## 10. Argon2id parameters are a mobile compromise

64 MiB of memory, not the 256 MiB of libsodium's `MODERATE` profile, because
mobile Safari fails the WASM allocation well below that. Iterations are raised
to 4 to compensate. A capsule that cannot be opened on a phone would be worse
than one that is somewhat cheaper to attack, but this is a trade, and it is
recorded here rather than hidden.

## 11. The retrieval lease is a window, not a transaction

A winning claimant holds a lease (default 15 minutes) during which the
ciphertext survives so a dropped connection does not destroy content nobody
read. Within that window the capsule is already consumed for everyone else. If
the claimant never returns, the worker destroys it when the lease expires.

## 12. Rate limiting is per-window and approximate

Fixed windows can allow up to 2× the nominal limit across a boundary. The limits
exist to stop bulk abuse of a public preview, not to meter a paid API.

## 13. Redis is not the source of truth

If Redis is flushed, rate-limit counters reset. Capsule state is unaffected —
PostgreSQL is the sole authority — but abuse control is briefly weakened.

## 14. No accounts, therefore no recovery

Lose the management link and there is no way to recover control of a capsule; it
will still expire on schedule. Lose a secure request's private key and the
deliveries are permanently unreadable. Both are consequences of not escrowing
keys, and both are stated in the UI at the moment the link is shown.

## 15. Secure-request submissions are not scanned

The server cannot inspect what a responder uploads — it is sealed to the
creator's public key. Nothing is scanned for malware, and the product never
claims otherwise. Treat a delivered file exactly as you would an email
attachment from a stranger.
