# ZigmaNeural — CRITICAL FRONTEND CORRECTION
# REMOVE ALL DUMMY DATA + REAL PRODUCTION DATA + COMPLETE UI/UX REDESIGN

==================================================
OBJECTIVE
==================================================

The previous frontend production pass is NOT ACCEPTED.

The frontend is still displaying dummy/demo data and the visual
quality is not production-grade.

The current screen visibly contains illustrative data such as:

- acmecorp.com
- Overall Score 87
- SEO 91
- AI Visibility 76
- Security 94
- Performance 82
- Accessibility 89
- Technical Health 86
- SSL 100
- QA 88
- Issues Found 23
- Critical Issues 3
- Improvements 47
- Pages Scanned 247
- Score Trend
- AI Agent Status
- fake execution/activity information
- "Demo Mode — all data is illustrative"

THIS MUST BE FIXED.

The application must use REAL backend/API/database data in
production.

If real data does not exist, show an honest empty/integration state.

NEVER show fake data to make the UI look populated.

==================================================
NON-NEGOTIABLE RULE
==================================================

REMOVE ALL MOCK / DEMO / ILLUSTRATIVE DATA FROM THE PRODUCTION
APPLICATION.

Search the ENTIRE frontend codebase for:

- mock
- mocks
- dummy
- demo
- sample
- illustrative
- placeholder
- fake
- fixture
- seed data used by frontend
- hardcoded metrics
- hardcoded scores
- hardcoded websites
- hardcoded agents
- hardcoded model names
- hardcoded chart datasets
- hardcoded execution history
- fallback sample objects
- fake API responses
- demo mode UI
- example data
- static dashboard values

Do not only fix the Overview page.

Audit EVERY PAGE and EVERY COMPONENT.

==================================================
1 — TRACE THE DATA FLOW FIRST
==================================================

Before modifying the UI, determine:

Frontend component
    ↓
API service
    ↓
Backend endpoint
    ↓
Database
    ↓
Tenant
    ↓
Authentication
    ↓
Real production record

For every dashboard metric, determine exactly where the value
comes from.

Create a frontend data-flow inventory:

Metric
→ API endpoint
→ response field
→ database source
→ tenant scope

Do this for:

- website
- overall score
- SEO
- AI visibility
- security
- performance
- accessibility
- technical health
- SSL
- QA
- issues
- critical issues
- improvements
- pages scanned
- score history
- agent status
- model usage
- executions
- evidence
- quality
- regeneration

If an endpoint does not exist, DO NOT invent data.

Show an honest empty/integration state instead.

==================================================
2 — PRODUCTION MODE MUST BE REAL
==================================================

The current banner:

"Demo Mode — all data is illustrative..."

must NOT appear in a properly configured production deployment.

Fix the environment/configuration behavior.

Verify:

VITE_APP_MODE
production configuration
API base URL
authentication
tenant context
backend connectivity

The production frontend must connect to the real backend.

Do not simply hide the banner.

Do not remove the banner while continuing to use dummy data.

Production mode must actually use production APIs.

==================================================
3 — REMOVE DEMO FALLBACKS
==================================================

Find every fallback such as:

if (!data) return demoData;

if (error) return sampleData;

const data = apiData || mockData;

const score = response.score || 87;

const website = website || "acmecorp.com";

Replace these patterns with proper states:

LOADING
SUCCESS
EMPTY
ERROR
UNAUTHORIZED
FORBIDDEN
INTEGRATION_REQUIRED

Never replace missing production data with fake data.

==================================================
4 — NO HARD-CODED BUSINESS DATA
==================================================

The following MUST NOT be hardcoded:

- website names
- scores
- metrics
- counts
- dates
- scan results
- issues
- agent status
- models
- execution history
- chart values
- quality scores
- evidence
- regeneration attempts

Static labels are allowed.

Business data is not.

==================================================
5 — REAL TENANT DATA
==================================================

All frontend data must belong to the authenticated tenant.

Never use:

acmecorp.com

or any example organization unless it is actually returned by the
authenticated backend.

Verify tenant isolation from frontend through the actual API flow.

The frontend must never construct tenant data locally.

==================================================
6 — REAL WEBSITE DATA
==================================================

The selected website shown in the header must come from the real
authenticated tenant's website records.

If there are multiple websites:

provide a real website selector.

The selector must load:

- website ID
- domain
- status
- last scan
- scan status

from the backend.

Do not use a hardcoded domain.

==================================================
7 — REAL DASHBOARD METRICS
==================================================

Every dashboard metric must come from the backend.

For example:

OVERALL SCORE
→ real latest quality/analysis result

SEO
→ real SEO result

AI VISIBILITY
→ real AI visibility result

SECURITY
→ real security result

PERFORMANCE
→ real performance result

ACCESSIBILITY
→ real accessibility result

TECHNICAL HEALTH
→ real technical health result

SSL
→ real SSL result

QA
→ real QA result

ISSUES FOUND
→ real findings

CRITICAL ISSUES
→ real critical findings

IMPROVEMENTS
→ real improvement recommendations

PAGES SCANNED
→ real scan/page evidence

Do not manufacture values if any of these are unavailable.

==================================================
8 — REAL SCORE LOGIC
==================================================

Do not calculate fake scores in the frontend.

If score calculation is a backend responsibility:

display the backend result.

If the backend has no result:

show:

"Not available yet"

or

"Run a scan to generate this score."

Do not display:

87
91
94
100

or any other fabricated values.

==================================================
9 — REAL SCORE TREND
==================================================

The Score Trend chart must use actual historical API data.

The chart must be generated from:

real scan/execution/quality history.

If fewer than the required number of data points exist:

show the actual available points.

Do not generate a synthetic trend.

Do not create fake improvement lines.

Do not extrapolate data just to make the chart look good.

If no history exists:

show a professional empty state:

"No score history yet"

"Run your first scan to start tracking intelligence over time."

==================================================
10 — REAL AI AGENT STATUS
==================================================

The AI Agent Status section must come from real execution data.

Display:

- actual agent
- actual execution
- actual status
- actual model where available
- actual start time
- actual completion time
- actual failure state

Do not show:

"Discovery — Complete"

"SEO — Complete"

"Security — Complete"

unless these are returned by the backend.

No fabricated execution activity.

==================================================
11 — REAL MODEL INFORMATION
==================================================

Any model displayed in the UI must come from:

Model Registry
Routing Decision
Agent Execution
OX Alpha execution metadata

Do not hardcode model names such as:

Llama
Claude
GPT
Gemini

unless returned by the backend.

==================================================
12 — REAL EXECUTION STATES
==================================================

AI workflows must clearly distinguish:

QUEUED
RUNNING
COMPLETED
FAILED
BLOCKED
CANCELLED
REQUIRES_REVIEW
INTEGRATION_REQUIRED

Never show completed status merely because the UI page loaded.

==================================================
13 — HONEST EMPTY STATES
==================================================

If a tenant has:

no website

show:

"No websites connected"

with:

"Add Website"

If there is no scan:

"No scan results yet"

with:

"Run New Scan"

If there is no score:

"Score unavailable"

If there is no evidence:

"No evidence collected"

If there is no quality assessment:

"No quality assessment available"

If the backend is unavailable:

"Backend integration unavailable"

If the API is not configured:

"Integration Required"

These states must look intentional and premium.

==================================================
14 — REMOVE DEMO MODE AS A PRODUCT EXPERIENCE
==================================================

Do not design the application around demo data.

Demo/development environments may use test fixtures internally,
but production UI must never present them as real customer data.

If a developer needs demo mode:

keep it isolated behind explicit development configuration.

Never silently fall back to demo mode.

==================================================
15 — CRITICAL UI/UX REDESIGN
==================================================

The current UI shown in the screenshot is NOT ACCEPTED as the final
visual design.

It looks like a basic internal admin dashboard.

Redesign it into a premium enterprise AI platform.

Do not simply change:

- colors
- border radius
- shadows
- font size

Perform a real UX redesign.

==================================================
16 — REDESIGN THE OVERVIEW
==================================================

The Overview page should answer:

1. What website am I analyzing?
2. What is its current intelligence/health state?
3. What needs attention?
4. What improved?
5. What is the AI system doing?
6. What should I do next?

Create a clear hierarchy.

Suggested structure:

HEADER
Website context + primary action

↓

EXECUTIVE HEALTH SUMMARY
Overall intelligence score + status

↓

INTELLIGENCE DIMENSIONS
SEO
AI Visibility
Security
Performance
Accessibility
Technical Health
SSL
QA

↓

PRIORITY ACTIONS
Critical issues
Important findings
Recommended improvements

↓

AI ACTIVITY
Current/recent real executions

↓

HISTORY
Real score/scan trend

Do not force every section into a card.

==================================================
17 — REDUCE VISUAL CLUTTER
==================================================

The current interface has too many:

- bordered cards
- boxes
- horizontal lines
- small labels
- tiny metrics
- dense sections

Reduce unnecessary containers.

Use whitespace and hierarchy.

Not everything needs to be a card.

==================================================
18 — IMPROVE THE SCORE VISUALIZATION
==================================================

The overall score should become a meaningful visual focal point.

It should communicate:

score
status
change
last analyzed
confidence where available
primary action

Example:

87

Good

+6 since previous scan

Last analyzed 27 Aug 2026

View analysis

ONLY use these values if they come from the API.

==================================================
19 — IMPROVE INTELLIGENCE DIMENSIONS
==================================================

Do not use eight nearly identical horizontal progress bars.

Create a more informative visual system.

Each dimension should show:

icon
name
score
status
change
optional finding count

Example:

Security
94
Excellent
↓ 2

Clicking should open the actual corresponding analysis.

==================================================
20 — PRIORITY-FIRST UX
==================================================

Critical issues should not look identical to normal metrics.

Prioritize:

CRITICAL
HIGH
MEDIUM
LOW

The user should immediately understand:

"What needs my attention?"

==================================================
21 — ACTION CENTER
==================================================

Create a strong "Recommended Actions" area using real findings.

Each action should communicate:

problem
impact
recommended action
severity
source
status

Actions must link to the relevant feature.

==================================================
22 — SCAN UX
==================================================

"New Scan" should be a primary product action.

Create a professional scan flow:

1. Select website
2. Select scan scope if supported
3. Review configuration
4. Start scan
5. Show live execution state
6. Show progress
7. Show results
8. Show quality verification
9. Show recommended actions

Use real backend states.

==================================================
23 — AI WORKFLOW UX
==================================================

Make the underlying intelligence visible without exposing
private model reasoning.

Show:

Task
↓
OX Alpha
↓
Specialist Agent
↓
Model
↓
Evidence
↓
Quality Verification
↓
Decision

Each stage must display actual state.

==================================================
24 — OX ALPHA
==================================================

OX Alpha is the supervisory intelligence.

Where appropriate, show structured information such as:

Decision:
"Selected Security Specialist"

Reason:
"Security analysis requires vulnerability evidence."

Model:
actual selected model

Do NOT expose chain-of-thought or private reasoning.

Use concise structured reasons only.

==================================================
25 — QUALITY UI
==================================================

Quality results must visually communicate:

Score
Decision
Blockers
Evidence grounding
Instruction validation
Output validity
Improvement targets

Use real API data.

No fabricated quality scores.

==================================================
26 — EVIDENCE UI
==================================================

Evidence must clearly communicate:

- source
- type
- timestamp
- freshness
- provenance
- validation state
- related finding
- confidence where supported

Do not make evidence look like generic text.

==================================================
27 — REGENERATION UI
==================================================

Show actual regeneration history.

Timeline:

Attempt
Score
Diagnosis
Strategy
Model/Agent change
Result

Only render actual attempts.

No fake attempts.

==================================================
28 — LOADING UX
==================================================

Never show fake data while loading.

Use:

skeleton screens
progressive loading
meaningful AI activity states

Example:

Loading dashboard...

Then:

Loading website health...

Loading intelligence scores...

Loading active executions...

==================================================
29 — ERROR UX
==================================================

If an API fails:

DO NOT silently replace the data.

Show:

what failed
what the user can do
retry

Example:

"Unable to load website intelligence."

"Retry"

For development/debugging, log technical details safely.

Do not expose stack traces to users.

==================================================
30 — VISUAL DESIGN
==================================================

Replace the current generic dashboard appearance.

Create a distinctive ZigmaNeural enterprise AI visual language.

Characteristics:

- premium
- sophisticated
- clean
- technical
- confident
- intelligent
- high information clarity

Avoid:

- generic admin-template appearance
- excessive cards
- excessive borders
- excessive rounded rectangles
- random gradients
- excessive glass effects
- excessive shadows
- meaningless charts
- decorative AI graphics

==================================================
31 — GRAPHICS
==================================================

Use purposeful graphics for:

- AI orchestration
- agent collaboration
- evidence flow
- model routing
- quality verification
- website intelligence

Graphics should help users understand the product.

Do not add decorative graphics merely to fill empty space.

==================================================
32 — ANIMATIONS
==================================================

Add subtle, premium animations.

Use animation for:

- navigation
- transitions
- score updates
- workflow progression
- status changes
- panel transitions
- chart rendering
- loading states

Do NOT animate everything.

Support:

prefers-reduced-motion.

==================================================
33 — RESPONSIVE DESIGN
==================================================

The current desktop design must NOT simply shrink on mobile.

Implement intentional responsive layouts.

Test:

320px
375px
390px
768px
1024px
1280px
1440px
1920px

No:

- horizontal overflow
- clipped cards
- broken tables
- overlapping dialogs
- inaccessible controls

==================================================
34 — SIDEBAR REDESIGN
==================================================

The sidebar should feel like enterprise product navigation.

Improve:

- hierarchy
- grouping
- active state
- icons
- spacing
- collapsible sections
- mobile behavior

Current navigation should be reorganized if necessary without removing
existing functionality.

==================================================
35 — HEADER REDESIGN
==================================================

The header should provide:

- current context
- website selector
- notifications
- primary scan action
- account context

Avoid unnecessary visual clutter.

==================================================
36 — ACCESSIBILITY
==================================================

Target:

WCAG 2.2 AA.

Verify:

- keyboard navigation
- focus states
- semantic HTML
- screen readers
- contrast
- dialogs
- forms
- charts
- status announcements
- reduced motion

==================================================
37 — PERFORMANCE
==================================================

Optimize:

- JavaScript
- images
- fonts
- charts
- animations
- route loading

Use:

- code splitting
- lazy loading
- virtualization where appropriate

Measure:

- bundle size
- LCP
- INP
- CLS

==================================================
38 — SECURITY
==================================================

Never expose:

- API keys
- OpenRouter keys
- OX Alpha credentials
- model provider secrets
- internal prompts
- database credentials

Treat all:

scanner output
website content
evidence
AI output

as untrusted content.

Render safely.

==================================================
39 — FRONTEND API ARCHITECTURE
==================================================

Create a clean API data layer.

Components must not contain duplicated API logic.

Use:

services
typed responses
query hooks/state management where appropriate
central error handling
central loading states

Do not put business logic directly into presentation components.

==================================================
40 — TYPESCRIPT
==================================================

Maintain strict TypeScript.

Do not fix errors using:

any
@ts-ignore
unsafe casts

Use proper types.

==================================================
41 — TESTING
==================================================

Add tests specifically preventing dummy data regression.

Tests must fail if production components render:

"acmecorp.com"

or hardcoded sample scores.

Add tests verifying:

- production mode uses API
- missing API data produces empty state
- API failure produces error state
- no demo fallback occurs
- tenant data is rendered
- score comes from API
- chart comes from API
- agent status comes from API

==================================================
42 — API CONTRACT VERIFICATION
==================================================

For every frontend API call:

verify that:

- endpoint exists
- authentication is sent
- tenant context is correct
- response schema matches frontend types
- errors are handled
- empty results are handled

If the backend endpoint is missing:

DO NOT create frontend fake data.

Report the missing backend dependency.

==================================================
43 — END-TO-END VERIFICATION
==================================================

Run the application in production configuration.

Use a real authenticated tenant.

Create/use a real website.

Run the actual workflow.

Verify that the Overview displays actual:

- website
- scan
- findings
- scores
- evidence
- agent activity
- quality results

Do not consider frontend work complete using only demo mode.

==================================================
44 — REMOVE THE CURRENT DEMO BANNER
==================================================

The banner:

"Demo Mode — all data is illustrative. Set VITE_APP_MODE=production..."

must disappear from the real production experience.

It may remain in an explicitly configured development/demo environment.

But production must not depend on it.

==================================================
45 — DO NOT HIDE PROBLEMS
==================================================

If production APIs are currently not returning the required data:

DO NOT:

- fabricate data
- hide errors
- use demo fallback
- hardcode values
- make the UI pretend everything works

Instead:

identify the exact missing integration.

Example:

Dashboard
→ /api/v1/dashboard
→ endpoint unavailable

or:

Score
→ API returns null
→ no completed scan exists

Document this honestly.

==================================================
46 — PRODUCTION ACCEPTANCE CRITERIA
==================================================

The implementation is NOT COMPLETE until:

[ ] No dummy data in production
[ ] No illustrative dashboard values
[ ] No hardcoded website names
[ ] No fake scores
[ ] No fake charts
[ ] No fake agent activity
[ ] No fake model names
[ ] No fake execution history
[ ] No fake evidence
[ ] No fake quality results
[ ] No fake regeneration attempts
[ ] No silent demo fallback
[ ] Production mode connects to real backend
[ ] Authenticated tenant data is displayed
[ ] Real website selector works
[ ] Real scans are displayed
[ ] Real findings are displayed
[ ] Real scores are displayed
[ ] Real history is displayed
[ ] Real agent executions are displayed
[ ] Real evidence is displayed
[ ] Real quality results are displayed
[ ] Real regeneration data is displayed
[ ] Empty states are honest
[ ] Error states are honest
[ ] Integration-required states are honest
[ ] No secrets exposed
[ ] Tenant isolation preserved
[ ] Existing APIs preserved
[ ] Existing backend functionality preserved
[ ] Existing backend tests pass
[ ] Existing frontend tests pass
[ ] Dummy-data regression tests added
[ ] TypeScript clean
[ ] Production build passes
[ ] Responsive testing passes
[ ] Accessibility testing passes
[ ] Performance measured
[ ] ARCHITECTURE.md updated

==================================================
47 — VISUAL ACCEPTANCE
==================================================

Do not declare success because:

"tokens were improved"
"cards were polished"
"animations were added"
"build passes"

The screenshot demonstrates that visual polish alone is not enough.

The final UI must:

- look substantially better
- communicate information clearly
- use real data
- have strong hierarchy
- feel premium
- feel intentional
- avoid dashboard clutter
- provide excellent empty/loading/error states
- work on mobile
- work with keyboard
- work with real production APIs

==================================================
48 — FINAL VERIFICATION REPORT
==================================================

At completion provide:

1. Complete dummy-data audit
2. List of removed mock/demo sources
3. Production API data-flow map
4. List of pages converted to real data
5. List of backend endpoints consumed
6. List of missing backend dependencies, if any
7. UI/UX changes
8. Graphics changes
9. Animation changes
10. Responsive testing results
11. Accessibility testing results
12. Performance measurements
13. Frontend test results
14. Backend test results
15. Production build result
16. Browser testing result
17. Screens/pages verified with real data
18. Any remaining blockers

==================================================
FINAL RULE
==================================================

REAL DATA > DEMO DATA

HONEST EMPTY STATE > FAKE DATA

REAL API INTEGRATION > VISUAL PLACEHOLDER

UX QUALITY > DECORATION

PRODUCTION BEHAVIOR > DEMO EXPERIENCE

DO NOT DECLARE THIS PHASE COMPLETE UNTIL THE ACTUAL
PRODUCTION DATA FLOW HAS BEEN VERIFIED END-TO-END.

The application must behave as a real production product,
not as a populated prototype.