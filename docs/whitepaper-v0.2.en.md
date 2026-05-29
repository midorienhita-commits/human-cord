<!--
  human cord — Concept White Paper v0.2 (English edition / deliverable)
  Parallel translation of docs/whitepaper-v0.2.ja.md.
  External reviewer distribution. Internal cross-references removed.
-->

# human cord

### An Infrastructure Where Lies Cannot Hide
#### A Cryptographic Infrastructure for Documentary Integrity in the AI Era

|  |  |
|---|---|
| **Version** | v0.2 (preliminary draft) |
| **Date** | 2026-05-29 |
| **Author** | ⟨full legal name — to be inserted just before Phase 3 publication⟩ |
| **Affiliation** | Independent project (unaffiliated; belongs to no company or organization) |
| **Status** | Phase 0 (design documentation) complete / Phase 1 (minimal POC) all 10 pillars reached / Phase 2 (physical layer) Pillar 7 protocol layer started |
| **Contact** | ⟨email address — to be inserted just before Phase 3 publication⟩ |
| **License** | Text: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)<br>Associated code: Apache License, Version 2.0 |

---

## 1. Abstract

As the capabilities of generative AI advance, the cost of superficially reproducing official documents and certificates is falling rapidly. Conventional digital signatures and public-key infrastructure (PKI) can detect tampering, but no adequate mechanism exists to give a document the persistent, intrinsic property that "**this document could only have been created by its issuer**." The human cord proposed in this white paper is a concept for an integrated cryptographic infrastructure that fills this gap.

human cord integrates **10 pillars** into **five domains plus one cross-cutting layer**: (i) the macro layer (the egg chain), (ii) the micro layer (the contents of each egg), (iii) the key-derivation layer, (iv) the verification layer, (v) the active-response layer, and (vi) the cross-cutting failure-boundary layer. Each pillar is, on its own, strongly connected to existing research and standards; rather than reinventing the wheel, the novelty lies in how they are combined. We present three principal contributions: first, a Subliminal Channel extended to the document level (Pillar 6); second, self-observation resistance that rigorously separates "form" from "secret" at the failure boundary (Pillar 10); and third, the tally operators `+/−` (Pillar 3), which reformulate BLS aggregate signatures as operators and branch automatically on verification failure.

As mid-to-long-term standardization goals, we have ISO/IEC 18033 (encryption algorithms), the annexes of ISO/IEC 27002 (controls), and IETF RFCs (via the IRTF CFRG) in view. At the time of writing, Phase 0 (design documentation) is complete, and in Phase 1 (a minimal Node.js POC) all ten pillars have reached implementation.

---

## 2. Motivation: Why a Mechanism, Not People, Should Guard the Truth

### 2.1 The Problem We Set Out to Solve

The outward appearance of official documents and certificates is becoming easy to reproduce by combining large language models with image-generation models. A digital signature is sufficient to show that "the issuer signed at a given point in time," but it remains passive — it can detect later modification, yet does not endow the whole document with the active property that "**this document could only have been created by its issuer in the first place.**" Blockchains are strong at making public records tamper-resistant, but they are not a technology for embedding issuer-identity inside the document itself; the two should be complementary.

### 2.2 The Project Constitution (Three Principles)

human cord holds, prior to any technical design, three principles as its constitution. First, build a **mechanism where lies cannot hide**: rather than preventing tampering outright, prioritize that the moment tampering occurs, a trace remains and persists. Second, create **a state in which rules are observed, rather than asserting rights**: instead of "rights-assertion" mechanisms such as access restriction, copy protection, and automatic reporting, aim for "rule-compliance" infrastructure in which anyone can judge authenticity. Third, **AI is AI and people are people** — rather than fighting, each fulfills its own role.

### 2.3 The Fourth Article: Separation of Technology, Law, and Ethics

Technology devotes itself to preserving truth; the role of punishing malice is left to law, and the role of choosing what is right is left to ethics. human cord merely raises smoke; judging that smoke belongs to the domain of people and law. We make explicit, as a premise of our design decisions, that technology **must not replace** law or ethics.

### 2.4 Three Gaps Existing Countermeasures Leave Open

First, even when tampering can be detected, it is hard to say strongly *from the document itself* "whose it is" (the limit of PKI). Second, cryptographic evidence is lost across media round-trips such as printing, scanning, and photography. Third, internal structure is exposed at the moment of failure (the lack of a systematic countermeasure against side-channel and fault attacks). The ten pillars presented here address these three gaps head-on through Pillars 4, 7, and 10 respectively.

---

## 3. Architecture Overview

The architecture of human cord can be grasped as a whole through the metaphor of an "egg chain" flowing over a transmission path. Each egg is sealed with standard authenticated encryption (AEAD), and the eggs are linked to one another by a hash chain (the macro layer). The contents of each egg are composed of multiple layers — eye-glyphs, landscape, latent noise, and a physical-layer signal (the micro layer). Over these, three further layers — key derivation, verification, and active response — are placed from the outside, and finally a cross-cutting behavioral discipline we call "self-observation resistance at the failure boundary" runs vertically through the entire process. This chapter surveys the role of each domain.

### 3.1 Five Domains Plus One Cross-Cutting Layer

| Domain | Pillars | Role |
|---|---|---|
| **Macro layer** (egg chain) | 9 | A carrier riding on standard AEAD |
| **Micro layer** (egg contents) | 2, 5, 6, 7 | Eye-glyph substitution / landscape blending / moving core / covert channel / physical-layer signal |
| **Key-derivation layer** | 1 | Zodiac-style multi-axis key = time (public) × issuer secret (private) |
| **Verification layer** | 3, 4 | Tally operators `+/−` + the issuer's private half |
| **Active-response layer** | 8 | Tamper detection → smoke + public log |
| **Failure boundary (cross-cutting)** | **10** | Runs vertically through the whole process. Desync detection / graceful degradation / internal-state leak resistance / observation evasion |

### 3.2 Architecture Diagram

Figure 1 shows a simplified data-flow diagram (a rendered version is at `docs/figures/architecture.en.svg`).

```mermaid
flowchart TB
    issuer[Issuer / private half] -->|derive| kdf["Pillar 1: zodiac multi-axis key"]
    plain["Plaintext ABCDEF…"] --> micro["Micro layer<br/>Pillars 2,5,6,7"]
    kdf --> micro
    micro --> macro["Macro layer<br/>Pillar 9: egg chain"]
    macro --> deliver([Delivery])
    deliver --> verify{"Verification<br/>Pillars 3,4"}
    verify -->|match| merged[Merged display]
    verify -->|no| smoke["Active response Pillar 8<br/>smoke + public log"]
    boundary["Pillar 10: failure boundary<br/>(cross-cutting, always active)"]
    boundary -.- micro
    boundary -.- macro
    boundary -.- verify
```

### 3.3 The Ten Pillars at a Glance

| # | Pillar | One-line summary |
|---|---|---|
| 1 | Zodiac-style multi-axis key generation | A moment-specific codebook from time + secret |
| 2 | Landscape blending | Only eye-glyphs are substituted; the rest passes through |
| 3 | Tally operators | `+` to merge / `−` to fire a difference |
| 4 | The issuer's private half | Without the issuer secret, neither verification nor decryption is possible |
| 5 | A living operator | Internal state keeps advancing via a ratchet |
| 6 | Subliminal channel | Noise in the eye-glyphs, decryptable only by the issuer |
| 7 | Physical-layer cross-modal signal | Detectable by phone sensors/cameras; survives printing |
| 8 | Active tamper response | On detection, raise "smoke" |
| 9 | Egg-flow architecture | AEAD + hash chain |
| 10 | Self-observation resistance at the failure boundary | Cross-cutting. On break, only form leaks; the secret does not |

---

## 4. Principal Contributions

### 4.1 Pillar 6: A Subliminal Channel Extended to the Document Level

The concept of the subliminal channel was proposed by Gustavus Simmons at CRYPTO '83; it makes it possible to embed, inside a digital signature, a second message that only the signer can read out [1]. To a verifier the signature looks entirely ordinary, and only a holder of a particular key can decrypt the hidden message. The academic literature is rich — the existence of a subliminal channel in Bitcoin's ECDSA has recently been pointed out — yet **no practically deployed standard exists at present**.

human cord scales this concept up from a single digital signature to **the level of an entire document**. The minute noise attached to eye-glyphs (selectively substituted characters introduced in Pillar 2) accumulates across the whole document and constitutes a "hidden document" decryptable only by the issuer. To a verifier's eye it displays as an ordinary certificate, while the issuer, by reading out the covert channel, can internally render the judgment "this is indeed something I issued."

The significance of this pillar is that even if AI achieves a perfect reproduction of the outward appearance, the covert channel itself cannot be generated without the issuer secret. In other words, against a situation in which visual authentication is losing trustworthiness in the AI era, it makes it possible to **retain issuer-identity in an invisible layer**.

### 4.2 Pillar 10: Self-Observation Resistance at the Failure Boundary

The greatest vulnerability in a cryptographic system often appears "at failure." Known attack families — fault attacks, side-channel attacks, downgrade attacks — all exploit the moment a system deviates from normal operation and its internal structure is exposed. This pillar is introduced as a cross-cutting design principle for systematically governing such exposure at the failure boundary.

The design principle reduces to a single sentence: **what is exposed when something breaks is only its "form"; the secret (the issuer key and the current value of dynamic internal state) does not leak even when it breaks.** Here "form" is the part that Kerckhoffs's principle presupposes to be public — concretely, the algebraic structures used, protocol identifiers, the referential structure of the data, and so on. These may be public without harming security, whereas the secret must always remain in the issuer's private half.

This pillar bundles the following four sub-functions in an integrated way.

| Sub-function | Content | Corresponding existing technique |
|---|---|---|
| Desync detection | Detect seq #/nonce drift early | TLS 1.3 record sequence, QUIC packet number |
| Controlled graceful degradation | Stepwise retreat from the tail via back-pressure | TCP flow control, reactive streams |
| Internal-state leak resistance | Even on break, the core's current state does not emerge | Side-channel masking, fault-injection countermeasures |
| Observation-evasion representation | The same pattern cannot be captured twice via screenshot/OCR | Moving-target defense |

Existing research on fault tolerance, side-channel countermeasures, and ratchets each has its own accumulated body of work, but a frame that bundles them under a single design principle has few precedents. The originality of this pillar is that it codifies Kerckhoffs's "separation of form and secret" as an implementation discipline **at the concrete, operable scene of the failure boundary**.

### 4.3 Pillar 3: Automatic Branching on Failure in the Tally Operators `+/−`

For the aggregation of digital signatures and the verification of relationships among multiple certificates, many existing techniques exist: BLS aggregate signatures (Boneh–Lynn–Shacham, 2004) [2], cryptographic accumulators, the presentation mechanism of W3C Verifiable Credentials, Myers diff, Merkle DAG diff, and so on. Each evolved for its own purpose, but from the standpoint of an operational authenticity-judgment UX they are not necessarily provided in an integrated form.

human cord integrates these into **a single operator algebra**. Specifically, the `+` operation expresses BLS aggregation, accumulator membership proof, and VC presentation as one and the same operation, while the `−` operation is defined as a difference-presentation mode that automatically falls back when `+` fails. The design in which **a failed operation returns not an error but another piece of useful information (a difference statement)** belongs to a rare class for a cryptographic protocol.

The operational significance of this pillar is clear. In ISMS audits, what was previously a binary judgment of "is this single signature verifiable?" is extended into a descriptive capacity of "**the relationships among multiple certificates can also be verified.**" In practical UX, a verifier always obtains either "a single merged sheet upon match" or "a comparison display with the difference made explicit," so a state of "cannot judge" cannot arise in principle.

### 4.4 Pillar 7: Physical-Layer Cross-Modal Signal (the Visual Channel)

A cryptographic signal that survives media round-trips such as printing, scanning, and photography sits at the intersection of the EURion constellation, TEMPEST, Li-Fi, and the like, and is a relatively young area for mainstream cryptographic engineering. No practically deployed standard exists at present.

For this pillar, human cord began a **minimal implementation of the protocol layer** in Phase 2. There are two design points. First, the locus of guarantees is clearly separated: **a smartphone's AI image analysis serves as the "eye" (robustness against distortion, lighting, and partial occlusion), while the cryptographic guarantees (authenticity, tamper detection, freshness) are borne by the cord side.** Advances in AI do not take over the guarantees. Second, on the premise of the fact that **an optical channel by itself cannot prevent replay** (an image of a photographed screen can be re-displayed and re-photographed to duplicate it), replay prevention is placed in the "protocol," not the "channel." Concretely, it combines one-time-use verification of a per-issuance unique nonce (the chain-tip hash), a freshness window based on a public time axis, and the "smoke" (Pillar 8) that rises upon detection of tampering or re-presentation.

This vertical slice is expected to obtain its first application in the concrete operational field of certificate issuance in BiosGuide; physical adapters such as actual pixel rendering, error-correcting codes, and camera/AI extraction remain as continuing work.

---

## 5. Connections to Existing Research

Each pillar of human cord has strong connections to existing cryptographic research, standards, and implementations. The novelty lies not in inventing individual techniques but in the way they are combined and in the cross-cutting design principles layered on top. This chapter presents the mapping to existing research carried out to avoid reinventing the wheel, and our positioning within a higher-level research area.

### 5.1 Ten Pillars × Existing Techniques (Compressed Matrix)

| Pillar | Principal existing techniques | Standardization status |
|---|---|---|
| 1 Zodiac multi-axis key | KDF / HKDF / ChaCha | NIST SP 800-108 / RFC 5869 |
| 2 Landscape blending | FPE / steganography | NIST SP 800-38G (FPE) |
| 3 Tally operators | BLS aggregate sig / accumulator / VC | IETF draft-irtf-cfrg-bls-signature |
| 4 Issuer's private half | PKI X.509 / threshold sig / Shamir SS | RFC 5280 / ISO/IEC 11770 |
| 5 Living operator | Signal Double Ratchet / sponge | IRTF CFRG / Signal spec |
| 6 Subliminal channel | **Simmons subliminal channel (1983)** | (standardization gap) |
| 7 Physical-layer signal | Physical-layer security / EURion / Li-Fi | IEEE 1900 series / 802.15.7 |
| 8 Active response | Cryptographic tripwire / HSM tamper / transparency log | FIPS 140-3 L4 / RFC 6962 |
| 9 Egg-flow architecture | AES-GCM / ChaCha20-Poly1305 / TLS 1.3 | RFC 8446 / NIST SP 800-38D |
| 10 Failure boundary | Side-channel countermeasures / MTD | (cross-cutting; no integrated standard) |

### 5.2 Positioning Within a Higher-Level Research Area

human cord as a whole can be positioned as one implementation of the active research area of **Moving Target Defense (MTD) cryptography**. MTD has accumulated research centered on the DARPA Moving Target program (since 2010) and NIST SP 800-160 Vol. 2 (Systems Security Engineering), but as of 2026 no general-purpose standard has yet been established. This document positions human cord as a candidate standard proposal against that gap.

### 5.3 Making Existing vs. Novel Explicit

To make the scope of our novelty claims explicit, we organize the contribution category of each pillar as follows. Pillars 1, 4, and 9 adopt existing techniques as-is, and we claim no novelty (reinvention avoidance). Pillars 2, 5, 7, and 8 are positioned as derivations/extensions of existing techniques. Pillars 3, 6, and 10 carry a commensurate room for novel contribution, as detailed in §4. And we present, as another contribution of this document, the integrating frame itself that ties the ten pillars into a single blueprint as five domains plus one cross-cutting layer.

---

## 6. Roadmap and Current Status

The human cord project is organized into six phases, from documenting the design through to standardization. Each phase has an independent exit deliverable and proceeds in an incrementally verifiable form. This chapter presents the overall roadmap and the several target specifications on the way to the final destination of international standardization.

### 6.1 Six-Phase Roadmap

| Phase | Exit | Status |
|---|---|---|
| 0 Document the foundation | Dream log + soul memo + architecture diagram + survey + this white paper | **Complete** |
| 1 Minimal Node.js POC | A working minimal human cord | **All 10 pillars reached implementation (zero dependencies, 61 tests)** |
| 2 Extension to the physical layer | A human cord that survives printing and photography | **Started (Pillar 7 protocol-layer POC; physical adapters ongoing)** |
| 3 Concept white paper v0.2 | A 5-page bilingual specification | This document = being finalized |
| 4 BiosGuide integration | Embedded into certificate issuance + audit logs | Not started |
| 5 Approach to Blancco | Begin dialogue with technical staff | Not started |
| 6 Standardization | IACR ePrint → SCIS → international conferences → IETF/NIST → ISO/IEC | Not started |

### 6.2 Standardization Targets

| Target specification | Relevant pillars | Estimated landing |
|---|---|---|
| ISO/IEC 18033 (encryption algorithms) | Pillars 5, 6, 9 integrated | 5–10 years |
| ISO/IEC 29192 (lightweight cryptography) | BiosGuide IoT application | 3–7 years |
| ISO/IEC 19772 (authenticated encryption) | Pillar 3 + Pillar 9 | 3–5 years |
| ISO/IEC 27002 annex | Whole-system operational guidance | 3–5 years |
| IETF RFC (via IRTF CFRG) | Individual specs for Pillars 5, 6, 8 | 2–4 years |

**Shortest route**: IRTF CFRG → IETF RFC → ISO adoption

---

## 7. References

1. Simmons, G. J. (1984). "The Prisoners' Problem and the Subliminal Channel." In *Advances in Cryptology: Proceedings of CRYPTO '83*, pp. 51–67. Plenum Press.
2. Boneh, D., Lynn, B., Shacham, H. (2004). "Short Signatures from the Weil Pairing." *Journal of Cryptology*, 17(4), 297–319.
3. Boneh, D., Gentry, C., Lynn, B., Shacham, H. (2003). "Aggregate and Verifiably Encrypted Signatures from Bilinear Maps." In *EUROCRYPT 2003*, LNCS 2656, pp. 416–432.
4. Shamir, A. (1979). "How to Share a Secret." *Communications of the ACM*, 22(11), 612–613.
5. Dodis, Y., Reyzin, L., Smith, A. (2004). "Fuzzy Extractors: How to Generate Strong Keys from Biometrics and Other Noisy Data." In *EUROCRYPT 2004*, LNCS 3027, pp. 523–540.
6. Bertoni, G., Daemen, J., Peeters, M., Van Assche, G. (2007). "Sponge Functions." *ECRYPT Hash Workshop 2007*.
7. Bernstein, D. J. (2008). "ChaCha, a Variant of Salsa20." *Workshop Record of SASC 2008*.
8. Marlinspike, M., Perrin, T. (2016). "The Double Ratchet Algorithm." Signal Technical Specification.
9. Kerckhoffs, A. (1883). "La cryptographie militaire." *Journal des sciences militaires*, IX, 5–38.
10. Camenisch, J., Lysyanskaya, A. (2002). "Dynamic Accumulators and Application to Efficient Revocation of Anonymous Credentials." In *CRYPTO 2002*, LNCS 2442, pp. 61–76.
11. Sporny, M., Longley, D., Chadwick, D. (2022). "Verifiable Credentials Data Model v1.1." W3C Recommendation.
12. Myers, E. W. (1986). "An O(ND) Difference Algorithm and Its Variations." *Algorithmica*, 1(1–4), 251–266.
13. Merkle, R. C. (1988). "A Digital Signature Based on a Conventional Encryption Function." In *CRYPTO '87*, LNCS 293, pp. 369–378.
14. Kocher, P., Jaffe, J., Jun, B. (1999). "Differential Power Analysis." In *CRYPTO '99*, LNCS 1666, pp. 388–397.
15. Boneh, D., DeMillo, R. A., Lipton, R. J. (2001). "On the Importance of Eliminating Errors in Cryptographic Computations." *Journal of Cryptology*, 14(2), 101–119.
16. Genkin, D., Shamir, A., Tromer, E. (2014). "RSA Key Extraction via Low-Bandwidth Acoustic Cryptanalysis." In *CRYPTO 2014*, LNCS 8616, pp. 444–461.
17. Pfitzmann, B., Waidner, M. (1992). "Attacks on Protocols for Server-Aided RSA Computation." In *EUROCRYPT '92*, LNCS 658.
18. NIST (2007). *SP 800-38D: Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC*.
19. NIST (2016). *SP 800-38G: Recommendation for Block Cipher Modes of Operation: Methods for Format-Preserving Encryption*.
20. NIST (2008/2022). *SP 800-108 Rev.1: Recommendation for Key Derivation Using Pseudorandom Functions*.
21. NIST (2018). *SP 800-160 Vol. 2: Developing Cyber-Resilient Systems — A Systems Security Engineering Approach*.
22. NIST (2019). *FIPS 140-3: Security Requirements for Cryptographic Modules*.
23. IETF (2010). *RFC 5869: HMAC-based Extract-and-Expand Key Derivation Function (HKDF)*.
24. IETF (2008). *RFC 5280: Internet X.509 Public Key Infrastructure Certificate and CRL Profile*.
25. IETF (2018). *RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3*.
26. IETF (2018). *RFC 8439: ChaCha20 and Poly1305 for IETF Protocols*.
27. IETF (2013). *RFC 6962: Certificate Transparency*.
28. ISO/IEC (2021). *ISO/IEC 18033-1:2021: Information security — Encryption algorithms — Part 1: General*.
29. ISO/IEC (2012). *ISO/IEC 29192-1:2012: Information technology — Security techniques — Lightweight cryptography — Part 1: General*.
30. ISO/IEC (2020). *ISO/IEC 19772:2020: Information security — Authenticated encryption*.
31. ISO/IEC (2010). *ISO/IEC 11770-1:2010: Information technology — Security techniques — Key management — Part 1: Framework*.
32. ISO/IEC (2022). *ISO/IEC 27002:2022: Information security, cybersecurity and privacy protection — Information security controls*.
33. IEEE (2018). *IEEE 802.15.7-2018: Short-Range Optical Wireless Communications*.
34. Haas, H., Yin, L., Wang, Y., Chen, C. (2016). "What is LiFi?" *Journal of Lightwave Technology*, 34(6), 1533–1544.
35. Mukhopadhyay, D., Chakraborty, R. S. (2014). *Hardware Security: Design, Threats, and Safeguards*. CRC Press.

> Note: each entry is based on a publicly known standard or paper, but edition numbers and years of publication will be finally cross-checked before distribution. Augmentation to roughly 40 entries is planned upon completion of Phase 3.

---

## Appendix A: Terminology Correspondence (Metaphor ↔ Cryptographic Engineering)

| Metaphor (human cord) | Cryptographic engineering |
|---|---|
| Egg | AEAD record / sealed box |
| Egg chain | Hash-linked record stream |
| Egg core | Stateful operator (ratchet) |
| Eye-glyph | Selectively format-preserved substituted character |
| Eye-glyph noise | Subliminal channel payload |
| Landscape blending | Non-substituted plaintext context |
| Zodiac multi-axis | Multi-dimensional KDF input |
| Pass token | Issuer-specific verification key |
| Tally (split tally) | Issuer's private half (cf. PKI private key) |
| Smoke | Tamper-evident broadcast signal |
| Private half | Private half of an asymmetric pair |
| Failure boundary | Failure-mode operational boundary |
| Rhythm break | seq #/nonce desync |
| A tail egg drops | Back-pressure-induced graceful degradation |

---

## Revision History

- 2026-05-28 Created as Phase 0 Task #6 (Japanese edition); §1–6 finalized in white-paper prose.
- 2026-05-29 Established as an external deliverable under `docs/`. Finalized cover elements (author name and contact are placeholders to be inserted just before Phase 3 publication; the rest are fixed), updated status to current state, promoted §4.4 Pillar 7 to a Phase 2 protocol-layer POC, converted the architecture diagram to Mermaid, and expanded references from 12 to 35. English parallel edition produced.
