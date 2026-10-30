# Gates: video-infra plan

Scope: planning document for project 06, built from the video transcript and the HTML blueprint. No code.

- [x] G1: every blueprint build item is covered in PLAN.md
  CHECK: for k in "Multipart" "Object storage" "Transcoding job queue" "resolution ladder" "HLS" "Signed playback" "watermark" "Device controls" "watch progress"; do grep -qi "$k" PLAN.md || echo MISSING:$k; done; echo done
  EXPECT: done
  EVIDENCE: done

- [x] G2: every blueprint AI item is covered
  CHECK: for k in "Speech to text" "Chapters" "Semantic search" "Video-grounded" "suspicious"; do grep -qi "$k" PLAN.md || echo MISSING:$k; done; echo done
  EXPECT: done
  EVIDENCE: done

- [x] G3: all 8 phases, measurable claims and risks sections exist
  CHECK: grep -c -E "^[1-8]\. \*\*" PLAN.md; echo; grep -c -E "^## (7|8)\." PLAN.md
  EXPECT: /8\s+2/
  EVIDENCE: 8 | 2

- [x] G4: style clean, no em dash, no curly quotes
  CHECK: grep -c -P "\x{2014}|\x{2013}|\x{201c}|\x{201d}|\x{2019}" PLAN.md; true
  EXPECT: 0
  EVIDENCE: 0

- [x] G5: unverified claims are labeled as such
  CHECK: grep -c -E "not checked|Not verified|I believe" PLAN.md
  EXPECT: /^[1-9]/
  EVIDENCE: 2

- [ ] G6: user review of the plan and open items in section 8
  EVIDENCE: pending
