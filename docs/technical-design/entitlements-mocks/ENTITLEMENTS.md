# Entitlements

<!--
THESIS: Access, licence and paid features sit in the existing settings shell; a missing entitlement explains itself instead of hiding the section.
OWN-WORLD: Reuse Bakery's approved Geist, neutral surfaces, cobalt selection, 208px application rail, 224px SectionNavigation and explicit light/dark token maps. No new visual language.
STORY: An administrator checks the licence, manages who has access, and meets one honest upsell where a paid feature is not entitled.
FIRST VIEWPORT: Page title and the one decision (licence status, people count, or the list) lead; banners sit above the top bar.
FORM: Extend the E03 settings surface. Phone uses one column with 44px controls.
-->

Mode: Operate. Editable design in
[Paper](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/p-17-0).

The original Paper design covers84 frames. Seventy-six active sources remain
the original exports for future routes. The eight installation-settings sources
now use owner-approved repository-authored derivatives; the original Paper
exports and all84 original reference PNGs remain unchanged. Source of truth is
the declared JSX path/hash in `source-manifest.json`. The Paper link and existing
frame IDs identify original ancestry, not the repository-only derivatives.
See [MOCK-BRIEF.md](MOCK-BRIEF.md) for the original frame table and the successor
record below for installation settings.

## Section navigation

Installation (Settings, Administrators, Licence) and Organization (Access,
Custom roles, Audit log, Single sign-on, SCIM) use the
[repo-wide SectionNavigation standard](../DESIGN.md#section-navigation).

| Section        | Route                          | Scope                                                                    |
| -------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Settings       | `/installation/settings`       | Registration mode and organization creation policy                       |
| Administrators | `/installation/administrators` | Installation administrators: list, add, revoke                           |
| Licence        | `/installation/licence`        | Licence status, key update                                               |
| Access         | `/organization/access`         | Members, invitations, roles per scope, service accounts, tokens, clients |
| Custom roles   | `/organization/roles`          | Paid: role list and permission picker                                    |
| Audit log      | `/organization/audit`          | Filtered log; paid export                                                |
| Single sign-on | `/organization/sso`            | Paid: OIDC and SAML providers, domain verification, enforcement          |
| SCIM           | `/organization/scim`           | Paid: token shown once, rotate, revoke, decommission                     |

## Roles and limits

- System roles: Admin, Developer, Viewer, Guest. Custom roles are a paid
  feature.
- Community plan: up to 5 people; over the limit, invitations are blocked until
  a licence is added or people are removed.
- Licence banners (grace, expired): installation administrators only, above the
  top bar.
- Seat banner over the free limit: persistent, non-dismissible, links to the
  licence page.
- FeatureGate upsell: inline (audit export) and full section (custom roles);
  built-in behaviour keeps working.

## Installation settings repository successor

Design review approved exactly eight repository-authored design
corrections and one additional capture/comparison after source/reference review.
An independent author wrote
standalone inline JSX from the reviewed specification and original design
lineage. No runtime component import, DOM/CSS scrape, candidate PNG copy, Paper
authoring/export call or fabricated ID/computed-style response was used.

The corrected shell depicts real available navigation, its Soon labels, neutral
Organization context and only the installed Settings section. Default policy is
Invitation only/Installation administrators only. Open is unavailable; Any user
means an authenticated human. Clean Save/Discard are disabled. The18px radio
glyph sits in a44px minimum row. Phone uses natural compact flow and real
Installation/logo/account chrome without cropping or sample/future sections.

Conflict/error retain Closed/installation_admins drafts and truthful generic
notices. Conflict offers Reload latest/Keep editing, without invented winner,
actor or time. Error offers Try again/Discard, without database diagnosis or
commit certainty. Static reference controls depict these states; actual CAS,
immutable retry and retained-draft behavior remain in the unchanged application.

Original computedStylesPath/hash bindings are historical Paper snapshots only;
they do not describe derivative geometry. Successor styles live in authored JSX.
Original tool/version/accessed2026-10-11 and node/page/file IDs remain ancestry.
The manifest source.method/referenceModel.note disclose the mixed source model.
The legacy paper: revision prefix hashes manifest bytes, not a live Paper event.

All suffixes below are under
`source/successors/installation-settings-v2/<suffix>.jsx`; original exports stay
under `source/<ancestry>.jsx` with their original style sidecars. Versioned PNG
destinations are
`../ui-baselines/paper/entitlements/installation-settings-v2/installation-settings--<suffix>.png`.

| Suffix | Paper ancestry | Original JSX SHA256 | Repository derivative SHA256 |
| --- | --- | --- | --- |
| default--dark--desktop | 2DA1-0 | d755cf624c5abcccee1907f68bb25575202bf458abb8104002e7f1671c01bca0 | aa7442abbb723f39f04bac873f67085f6f129662ee65a88210e60a3e71eeaf51 |
| default--light--desktop | 2C24-0 | 95ba6d3f0c00992e72b26dc556f502fc309083236aed60a5ffc1756caf1e7901 | 836bb6966483b29ccf61ef6e059e7c8aa552973c777afb3a7611929d9fe7d5ed |
| default--dark--phone | 2DYC-0 | 1b28e2d08987aa076fb1b68d5af8ab5023543a7080f7122d6f87be023aa9934f | fe90a67e8ae33ced1a43b953b714a956ee6b24040c367483aa15795a883cf292 |
| default--light--phone | 2D27-0 | 3f0838b730c6c88a310fd0a8336941a0591bf3180bfe3493a13e525cc67c1b9d | 34dd223da76bfdf0040b9e1477010ef1ab1e7eb320fd6f953ce8c4613943de4c |
| save-conflict--light--desktop | 2E5Y-0 | 17e80b15bdca096662b8e1534b29fe4ca1235958a078e137622bcb66f49402c2 | 0d7c6f2938616544b8d8e24bdcf6bd64262ecfb548413fb11cb6e24401e479ca |
| save-conflict--light--phone | 2E62-0 | ae2fba9a7c49ce3bbee7a20cc6badc6bcbee2f4b2d66f92c6da47a3493912521 | 4026f343b175fdc18cbd93868c4cb0b9d72b41a226dab422597543bc0fae6452 |
| save-error--light--desktop | 2E5Z-0 | 2d1ba1244bc49566642ef556dbe82107e68dbf1af3195cb8c8b872e067cf4fe6 | 47764c50acc540910d0e8de2a567f26be420dfdd67bf9ce7606d315b85543db4 |
| save-error--light--phone | 2E63-0 | d3687d0d8c2f82d6787348e0db04e188cdaa90f6cf72208737085c50b17d37be | a1c62e48f0cbc611072f4b7f694cdd0db6e1d6c4ab9d77de44c8e0072eb8d8b0 |

Both case.imagePath and screen.referencePath were bound before the writer. On
2026-10-12, the sanctioned renderer wrote all84 cases, preserving all84
original PNGs byte-for-byte and adding the eight versioned successor PNGs.
Their actual hashes are bound in both the screen and case metadata. The76
unaffected sources, cases and regenerated reference bytes remain unchanged.
The final aggregate source identity covers the finalized manifest and existing
101 ordered inputs; the revision's paper: prefix is a manifest-byte hash, not a
new Paper access or export claim. Full-frame dimensions, strict schema and the
inclusive0.95 threshold remain unchanged. Cycles1/2 remain failed; the one
approved further cycle still requires all eight actual scores>=0.95.

## installation-settings-v3 (desktop successors)

Licence and Audit log were added to the installation section navigation and
relabelled the active item Installation settings (59623377). The v2 desktop
references show a two-item nav, so save-conflict and save-error scored 0.9433
and 0.9344 against the inclusive 0.95 threshold. Decision:
add repository-authored successors
`source/successors/installation-settings-v3/<suffix>.jsx` for the four desktop
frames, with the real four-item nav, rendered by the sanctioned renderer to
`../ui-baselines/paper/entitlements/installation-settings-v3/installation-settings--<suffix>.png`.
v2 sources and PNGs stay committed and unchanged; the phone frames stay on v2.
Threshold, selection and schema are unchanged. No new Paper access or export.

| Suffix | Repository derivative SHA256 | Reference PNG SHA256 |
| --- | --- | --- |
| default--dark--desktop | d87bbafc50ebeea47b7934c4354f3d77b63ae5e2ad283855536f0e8c01a9ff46 | f542436d5890664bc48f7034c0af867b55e39f33c99a09c153a91fdd0888e466 |
| default--light--desktop | 34af4085d231654e0ac2c8617d9758df8c56bf7896acb53788ce617835b33279 | d8e43448607be7e7cd204757906ff9c3f86bf34bd03cf851e35d25ab6c46c5c0 |
| save-conflict--light--desktop | 0ec0d3af42f133a55d4c6364046725ab221b36fb1b93272a9b82702af0650200 | 419d12bbd90d704e4de704bd1afe4735fc1f14b7c3b7524bbf9a18578975086f |
| save-error--light--desktop | ab21e9edfbe1286fb12508eaad311e4630bfca253b06f1cde8f00bc4449c0b7c | 82a11d549e3f2eec0c91a5052fea11ad7a134fa8ed80c28d3ca8285172066274 |
