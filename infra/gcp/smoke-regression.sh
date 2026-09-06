#!/usr/bin/env bash
set -u

BASE_URL="${BASE_URL:-http://127.0.0.1:8084}"
TMP_DIR="$(mktemp -d)"
SMOKE_ISSUE="SMOKE-REGRESSION-$$"
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

cleanup() {
  curl -sS -X DELETE     "${BASE_URL}/api/v2/document-drafts/${SMOKE_ISSUE}?template_type=legal_response"     >/dev/null 2>&1 || true
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

pass() { printf 'PASS  %s\n' "$*"; PASS_COUNT=$((PASS_COUNT+1)); }
warn() { printf 'WARN  %s\n' "$*"; WARN_COUNT=$((WARN_COUNT+1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAIL_COUNT=$((FAIL_COUNT+1)); }

http_json() {
  local method="$1" url="$2" body="${3:-}"
  local out="$TMP_DIR/response.json"
  local code
  if [[ -n "$body" ]]; then
    code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method"       -H 'Content-Type: application/json' --data-binary "@$body" "$url") || return 1
  else
    code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url") || return 1
  fi
  printf '%s' "$code"
}

echo "LegalBridge V2 regression smoke"
echo "BASE_URL=$BASE_URL"
echo

# 1. Health / guarded write-test capabilities.
code=$(http_json GET "$BASE_URL/health") || code=000
if [[ "$code" == "200" ]] &&
   jq -e '.ok == true and .accessMode == "readwrite" and .database.reachable == true and .database.readOnly == false'       "$TMP_DIR/response.json" >/dev/null; then
  pass "health / production DB reachable in guarded readwrite mode"
else
  fail "health (HTTP $code)"
fi

required_caps='["drafts","documents","pdf","outbound-conditions","contract-intake","matters","vendors","staff","works","materials","condition-attachments"]'
if jq -e --argjson req "$required_caps" '
  (.writeCapabilities // []) as $caps
  | all($req[]; . as $x | $caps | index($x) != null)
' "$TMP_DIR/response.json" >/dev/null 2>&1; then
  pass "expected write capabilities exposed"
else
  fail "write capabilities incomplete"
fi

# 2. Deadline timezone regression. These are known recoverable production requests.
code=$(http_json GET "$BASE_URL/api/v2/deadline-events?from=2026-09-07&to=2026-09-11") || code=000
if [[ "$code" == "200" ]]; then
  pass "deadline endpoint"
  expected='{"request:498":"2026-09-07","request:501":"2026-09-07","request:508":"2026-09-09","request:509":"2026-09-10","request:500":"2026-09-11","request:511":"2026-09-11","request:512":"2026-09-11"}'
  if jq -e --argjson expected "$expected" '
    (.events // [] | map({key:.id,value:.dueDate}) | from_entries) as $actual
    | all($expected | to_entries[]; $actual[.key] == .value)
  ' "$TMP_DIR/response.json" >/dev/null; then
    pass "Tokyo deadline dates 498/501/508/509/500/511/512"
  else
    fail "Tokyo deadline date mapping differs from expected"
    jq '[.events[] | select(.id|IN("request:498","request:501","request:508","request:509","request:500","request:511","request:512")) | {id,dueDate}]'       "$TMP_DIR/response.json"
  fi
else
  fail "deadline endpoint (HTTP $code)"
fi

# 3. Document registry + previous number compatibility field.
code=$(http_json GET "$BASE_URL/api/v2/documents?limit=200") || code=000
if [[ "$code" == "200" ]] && jq -e '.documents | type == "array"' "$TMP_DIR/response.json" >/dev/null; then
  cp "$TMP_DIR/response.json" "$TMP_DIR/documents.json"
  pass "document registry list"
  if jq -e '.documents | length > 0 and all(.[]; has("previousDocumentNumber"))' "$TMP_DIR/response.json" >/dev/null; then
    pass "previousDocumentNumber compatibility field present"
  else
    fail "previousDocumentNumber field missing"
  fi
  prev_count=$(jq '[.documents[] | select(.previousDocumentNumber != null and .previousDocumentNumber != "")] | length' "$TMP_DIR/response.json")
  if [[ "$prev_count" -gt 0 ]]; then
    pass "old document number history populated ($prev_count document(s))"
  else
    warn "no populated old-number sample in first 200 documents; API field is present"
  fi
else
  fail "document registry list (HTTP $code)"
fi

# 4. Draft write/read/delete + finalization conflict path without creating a document.
code=$(http_json GET "$BASE_URL/api/v2/document-templates/legal_response/form-schema") || code=000
if [[ "$code" == "200" ]]; then
  cp "$TMP_DIR/response.json" "$TMP_DIR/schema.json"
  version=$(jq -r '.templateVersionId // empty' "$TMP_DIR/schema.json")
  jq '
    def sample($f):
      if $f.type == "date" then "2026-09-05"
      elif $f.type == "number" then 1
      elif $f.type == "checkbox" then true
      elif $f.type == "select" then
        (($f.options // [])[0] // "SMOKE")
        | if type == "object" then (.value // .label // "SMOKE") else . end
      else "SMOKE" end;
    reduce (.fields // [])[] as $f ({}; .[$f.name] = sample($f))
  ' "$TMP_DIR/schema.json" > "$TMP_DIR/form-data.json"
  jq -n --arg tt "legal_response" --slurpfile fd "$TMP_DIR/form-data.json"     '{templateType:$tt,formData:$fd[0],updatedBy:"tatsuya.kuramochi@arclight.co.jp"}'     > "$TMP_DIR/draft-put.json"

  code=$(http_json PUT "$BASE_URL/api/v2/document-drafts/$SMOKE_ISSUE" "$TMP_DIR/draft-put.json") || code=000
  if [[ "$code" == "200" ]] && jq -e '.draft.updatedAt != null' "$TMP_DIR/response.json" >/dev/null; then
    pass "draft create"
    updated_at=$(jq -r '.draft.updatedAt' "$TMP_DIR/response.json")
    code=$(http_json GET "$BASE_URL/api/v2/document-drafts/$SMOKE_ISSUE?template_type=legal_response") || code=000
    if [[ "$code" == "200" ]] && jq -e --arg issue "$SMOKE_ISSUE" '.draft.issueKey == $issue' "$TMP_DIR/response.json" >/dev/null; then
      pass "draft read round-trip"
    else
      fail "draft read round-trip (HTTP $code)"
    fi

    jq -n       --arg issue "$SMOKE_ISSUE"       --arg tt "legal_response"       --argjson version "$version"       --slurpfile fd "$TMP_DIR/form-data.json"       '{
        issueKey:$issue,
        templateType:$tt,
        templateVersionId:$version,
        formData:$fd[0],
        expectedDraftUpdatedAt:"2000-01-01T00:00:00.000Z",
        createdBy:"tatsuya.kuramochi@arclight.co.jp"
      }' > "$TMP_DIR/finalize.json"

    code=$(http_json POST "$BASE_URL/api/v2/documents/finalize" "$TMP_DIR/finalize.json") || code=000
    if [[ "$code" == "409" ]] && jq -e '.error | test("draft changed")' "$TMP_DIR/response.json" >/dev/null; then
      pass "document finalize path reached safe conflict guard (no document created)"
    else
      fail "document finalize conflict guard (HTTP $code)"
      cat "$TMP_DIR/response.json"
    fi

    code=$(http_json DELETE "$BASE_URL/api/v2/document-drafts/$SMOKE_ISSUE?template_type=legal_response") || code=000
    if [[ "$code" == "200" ]] && jq -e '.ok == true' "$TMP_DIR/response.json" >/dev/null; then
      pass "draft cleanup"
    else
      fail "draft cleanup (HTTP $code)"
    fi
  else
    fail "draft create (HTTP $code)"
    cat "$TMP_DIR/response.json"
  fi
else
  fail "legal_response form schema (HTTP $code)"
fi

# 5. Existing finalized document + PDF.
# Document 1033 is retained as the historical condition-attachment sample, but it
# may use an attachment/legacy template with no current render source. For PDF,
# select a finalized document whose template key and version match an active
# current document template, then try compatible candidates until one renders.
code=$(http_json GET "$BASE_URL/api/v2/documents/1033") || code=000
if [[ "$code" == "200" ]] && jq -e '.document.id == 1033 and .document.lifecycle.pdfState == "ready"' "$TMP_DIR/response.json" >/dev/null; then
  pass "finalized document 1033 registry read"
else
  fail "document 1033 registry read (HTTP $code)"
fi

code=$(http_json GET "$BASE_URL/api/v2/document-templates") || code=000
if [[ "$code" == "200" ]] && jq -e '.templates | type == "array"' "$TMP_DIR/response.json" >/dev/null; then
  cp "$TMP_DIR/response.json" "$TMP_DIR/templates.json"
  pass "document template registry for PDF candidate selection"
else
  fail "document template registry (HTTP $code)"
fi

pdf_candidate_ids=$(
  jq -nr \
    --slurpfile docs "$TMP_DIR/documents.json" \
    --slurpfile templates "$TMP_DIR/templates.json" '
      ($templates[0].templates
        | map({key:.templateKey,value:.templateVersionId})
        | from_entries) as $versions
      | $docs[0].documents[]
      | select(.documentNumber != null and .documentNumber != "")
      | select($versions[.templateType] != null)
      | select(
          .templateVersionId == null
          or .templateVersionId == $versions[.templateType]
        )
      | .id
    ' 2>/dev/null || true
)

pdf_ok=false
pdf_attempts=0
pdf_last_code=""
pdf_last_body=""
for pdf_id in $pdf_candidate_ids; do
  pdf_attempts=$((pdf_attempts+1))
  [[ "$pdf_attempts" -gt 20 ]] && break
  pdf_file="$TMP_DIR/document-$pdf_id.pdf"
  headers="$TMP_DIR/pdf-headers.txt"
  pdf_code=$(curl -sS -D "$headers" -o "$pdf_file" -w '%{http_code}' \
    "$BASE_URL/api/v2/documents/$pdf_id/pdf") || pdf_code=000
  pdf_last_code="$pdf_code"
  if [[ "$pdf_code" == "200" ]] &&
     grep -qi '^content-type: application/pdf' "$headers" &&
     head -c 5 "$pdf_file" | grep -q '%PDF-'; then
    pass "PDF generation compatible document $pdf_id"
    pdf_ok=true
    break
  fi
  if [[ -s "$pdf_file" ]]; then
    pdf_last_body=$(head -c 500 "$pdf_file" | tr '\n' ' ')
  fi
done

if [[ "$pdf_ok" != "true" ]]; then
  if [[ -z "$pdf_candidate_ids" ]]; then
    fail "PDF generation: no finalized document matches an active template/version"
  else
    fail "PDF generation: no compatible candidate rendered (last HTTP ${pdf_last_code:-none})"
    [[ -n "$pdf_last_body" ]] && printf '      last response: %s\n' "$pdf_last_body"
  fi
fi

# 6. Contract intake validation + DB preflight only; never commit.
cat > "$TMP_DIR/intake.json" <<'JSON'
{
  "sourceWork": {
    "title": "SMOKE 原作",
    "workType": "board_game"
  },
  "ownWork": {
    "title": "SMOKE 自社作品",
    "workType": "board_game",
    "status": "planning"
  },
  "materials": [{
    "materialName": "SMOKE ゲームデザイン",
    "materialType": "game_design",
    "materialRole": "core_logic",
    "acquisitionType": "license",
    "rightsType": "license",
    "isDefault": true
  }],
  "contract": {
    "documentNumber": "SMOKE-PREFLIGHT-NO-COMMIT",
    "contractTitle": "SMOKE 契約取込プリフライト",
    "primaryVendorId": 36,
    "executedAt": "2026-09-05"
  },
  "inboundConditions": [{
    "conditionName": "SMOKE 原作利用許諾",
    "transactionKind": "license",
    "materialIndex": 0,
    "territory": "日本",
    "languages": ["日本語"],
    "paymentScheme": "royalty",
    "ratePct": 5
  }],
  "outboundConditions": []
}
JSON

code=$(http_json POST "$BASE_URL/api/v2/contract-intakes/validate" "$TMP_DIR/intake.json") || code=000
if [[ "$code" == "200" ]] && jq -e '.ok == true' "$TMP_DIR/response.json" >/dev/null; then
  pass "contract intake schema validation"
else
  fail "contract intake validation (HTTP $code)"
fi

code=$(http_json POST "$BASE_URL/api/v2/contract-intakes/preflight" "$TMP_DIR/intake.json") || code=000
if [[ "$code" == "200" ]] && jq -e '.preview.committable == true' "$TMP_DIR/response.json" >/dev/null; then
  pass "contract intake DB preflight (no commit)"
else
  fail "contract intake DB preflight (HTTP $code)"
  cat "$TMP_DIR/response.json"
fi

# 7. Master registry reads.
code=$(http_json GET "$BASE_URL/api/v2/vendors/36") || code=000
if [[ "$code" == "200" ]] && jq -e '(.vendor.id // .id) == 36' "$TMP_DIR/response.json" >/dev/null; then
  pass "vendor master read (36)"
else
  fail "vendor master read (HTTP $code)"
fi

code=$(http_json GET "$BASE_URL/api/v2/staff") || code=000
if [[ "$code" == "200" ]] && jq -e '.items | type == "array"' "$TMP_DIR/response.json" >/dev/null; then
  pass "staff master list"
else
  fail "staff master list (HTTP $code)"
fi

code=$(http_json GET "$BASE_URL/api/v2/works/1000000043") || code=000
if [[ "$code" == "200" ]] && jq -e '.work.id == 1000000043' "$TMP_DIR/response.json" >/dev/null; then
  pass "work master read (1000000043)"
else
  fail "work master read (HTTP $code)"
fi

code=$(http_json GET "$BASE_URL/api/v2/work-rights/1000000043") || code=000
material_id=""
if [[ "$code" == "200" ]]; then
  material_id=$(jq -r '.materials[0].id // empty' "$TMP_DIR/response.json")
  pass "work-rights read for material lookup"
else
  fail "work-rights read for material lookup (HTTP $code)"
fi
if [[ -n "$material_id" ]]; then
  code=$(http_json GET "$BASE_URL/api/v2/materials/$material_id") || code=000
  if [[ "$code" == "200" ]] && jq -e --argjson id "$material_id" '.material.id == $id' "$TMP_DIR/response.json" >/dev/null; then
    pass "material master read ($material_id)"
  else
    fail "material master read (HTTP $code)"
  fi
else
  warn "work 1000000043 has no material sample; material detail smoke skipped"
fi

# 8. Condition attachment read context. No new condition is inserted.
code=$(http_json GET "$BASE_URL/api/v2/documents/1033/condition-attachments") || code=000
if [[ "$code" == "200" ]] &&
   jq -e '.document.id == 1033 and (.conditions | type == "array")' "$TMP_DIR/response.json" >/dev/null; then
  pass "condition attachment context document 1033"
  cond_count=$(jq '.conditions | length' "$TMP_DIR/response.json")
  if [[ "$cond_count" -ge 3 ]]; then
    pass "condition attachment round-trip includes existing condition lines ($cond_count)"
  else
    warn "document 1033 condition count is $cond_count; expected historical sample >= 3"
  fi
else
  fail "condition attachment context (HTTP $code)"
fi

echo
printf 'SUMMARY PASS=%d WARN=%d FAIL=%d\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
