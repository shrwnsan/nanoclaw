# Tasks for PRD-001: Unified CLI Architecture

**PRD:** `docs/prd-001-unified-cli-architecture.md`
**Created:** 2026-04-17
**Last reviewed:** 2026-04-17

## Dependency Graph

```
Phase 1:  [1.1 ✅] ──┐
          [1.2 ✅] ──┼──► [1.4 ✅] ──► [1.5 ⏳]
          [1.3 ✅] ──┘

Phase 2:  [2.1 ✅]  [2.2 ✅]  [2.3 ✅]   ← all done

Phase 3:  [3.1 ✅]  [3.2 ✅]  [3.3 ✅]  [3.4 ✅]  [3.5 ✅]  ← all done

Phase 4:  [4.1 ✅]  [4.2 ⏳]   ← 4.1 done by Phase 1 rewrite
```

---

## Phase 1: Unify CLI through WeatherSkill

### Task 1.1 — Create `CliTextFormatter` ✅

**File:** `weather/formatters/cli_text.py`
**Depends on:** nothing
**Parallel:** yes (with 1.2, 1.3)
**Completed:** 2026-04-17 (commit `54a8a21`)

Create a new formatter that extends `WeatherFormatter` and produces plain-text CLI output from `WeatherData` objects.

**Steps:**

1. Create `weather/formatters/cli_text.py`
2. Define `class CliTextFormatter(WeatherFormatter)` with `platform = "text"`
3. Implement `format_current(self, data: WeatherData) -> str`:
   - Port logic from current `cli.py:format_text()` (lines 132-172)
   - Read from `WeatherData` properties directly (not dict keys)
   - Use `data.wind_str` (property), `data.humidity_str`, `data.emoji`, etc.
   - Include all fields: temperature, feels_like, temp range, humidity, wind, precipitation_chance, uv_index, aqhi/aqi, provider_name
4. Implement `format_forecast(self, data: list[WeatherData]) -> str`:
   - Port forecast formatting from `cli.py:format_text()` lines 134-141
   - Use `data.forecast_date`, `data.temp_high`, `data.temp_low`, `data.description`
5. Add to `weather/formatters/__init__.py`: import and export `CliTextFormatter`

**Verify:**
```python
from weather.formatters.cli_text import CliTextFormatter
from weather.models import WeatherData, WeatherCondition
d = WeatherData(location="Test", temperature=25.0, humidity=80,
                wind_description="NE 12 km/h", condition=WeatherCondition.SUNNY)
f = CliTextFormatter()
output = f.format_current(d)
assert "25°C" in output
assert "NE 12 km/h" in output  # this currently fails with format_text()
assert "80%" in output
```

---

### Task 1.2 — Create `bootstrap.py` ✅

**File:** `weather/bootstrap.py`
**Depends on:** nothing
**Parallel:** yes (with 1.1, 1.3)
**Completed:** 2026-04-17 (commit `54a8a21`)

Create a factory function that wires up a fully-configured `WeatherSkill` instance.

**Steps:**

1. Create `weather/bootstrap.py`
2. Define `build_default_skill(**overrides) -> WeatherSkill`
3. Register **free providers** unconditionally:
   - `HKOProvider()` — priority 1
   - `SGNEAProvider()` — priority 2
   - `JMAProvider()` — priority 3
   - `BOMProvider()` — priority 6
   - `MetServiceProvider()` — priority 7
   - `NWSProvider()` — priority 7
   - `BMKGProvider()` — priority 8
   - `DWDProvider()` — priority 8
4. Register **key-required providers** only when env var is set:
   - `CWAProvider()` if `CWA_API_KEY` set
   - `UKMetOfficeProvider()` if `METOFFICE_API_KEY` set
   - `KMAProvider()` if `KMA_SERVICE_KEY` set
   - `TMDProvider()` if `TMD_API_TOKEN` set
   - `OpenWeatherMapProvider(api_key=...)` if `OPENWEATHERMAP_API_KEY` set
5. Register formatters:
   - `"text"` → `CliTextFormatter()`
   - `"telegram"` → `TelegramFormatter()`
   - `"whatsapp"` → `WhatsAppFormatter()`
6. Register senders (only when configured):
   - `"telegram"` → `TelegramSender()` if `TELEGRAM_BOT_TOKEN` set
7. Accept optional `**overrides` for tests (e.g., `providers=[...]` to override)

**Verify:**
```python
from weather.bootstrap import build_default_skill
skill = build_default_skill()
assert len(skill.providers) >= 8  # free providers
assert "text" in skill.platforms
assert "telegram" in skill.platforms
```

---

### Task 1.3 — Fix `TelegramSender` to use `urllib` instead of `curl` ✅

**File:** `weather/senders/telegram.py`
**Depends on:** nothing
**Parallel:** yes (with 1.1, 1.2)
**Completed:** 2026-04-17 (commit `54a8a21`)
**Review note:** `asyncio.get_event_loop()` on line 128 was not updated to `get_running_loop()` — tracked under Task 3.1.

Replace the `subprocess.run(["curl", ...])` implementation with `urllib.request`.

**Steps:**

1. In `_send_via_json()`, replace the curl subprocess call (lines 150-169) with:
   ```python
   def send():
       payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
       req = urllib.request.Request(
           url,
           data=payload_bytes,
           headers={"Content-Type": "application/json"},
           method="POST",
       )
       with urllib.request.urlopen(req, timeout=self.timeout) as resp:
           return json.loads(resp.read().decode("utf-8"))
   ```
2. Remove `import subprocess` and `import tempfile` (no longer needed)
3. Remove the temp file creation and cleanup logic entirely
4. Keep `await loop.run_in_executor(None, send)` wrapper

**Why:** The current approach exposes `bot_token` in the URL argument visible via `ps aux`. `urllib` keeps the token in-process memory only.

**Verify:**
```bash
# After fix, this should show no curl processes with bot tokens:
# (run a send operation and check ps aux simultaneously)
python -c "
import asyncio
from weather.senders.telegram import TelegramSender
# Would need valid token to fully test, but verify no subprocess import needed
"
```

---

### Task 1.4 — Rewrite `cli.py` to use `WeatherSkill` ✅

**File:** `weather/cli.py`
**Depends on:** 1.1, 1.2, 1.3
**Parallel:** no
**Completed:** 2026-04-17 (commit `54a8a21`)
**Review note:** Also completed Task 2.3 (hardcoded chat ID) and Task 4.1 (dead code) as side effects of the rewrite. The old `--platform` and `--format` flags were unified into a single `--format` flag with choices `[text, telegram, whatsapp, json]`.

Rewrite `main()` to route through `build_default_skill()` and delete all bypassed code.

**Steps:**

1. **Update imports** at top of file:
   - Remove try/except import block (lines 24-36)
   - Add: `from .bootstrap import build_default_skill`
   - Add: `from dataclasses import asdict`

2. **Update `create_parser()`:**
   - Change `--provider` choices: remove `choices=["hko", "auto"]`, keep `default="auto"`, add help text listing available providers
   - Change `--platform` choices: `["text", "telegram", "whatsapp", "json"]` or remove `--format` and unify into `--platform`

3. **Rewrite `main()`** (~40 lines replacing ~65):
   ```python
   async def main(args):
       skill = build_default_skill()
       provider_name = None if args.provider == "auto" else args.provider

       # Fetch
       if args.forecast:
           data = await skill.get_forecast(args.location, args.days, provider_name)
       else:
           data = await skill.get_current(args.location, provider_name)

       # JSON output (direct serialization, not a formatter)
       if args.format == "json":
           if isinstance(data, list):
               output = [asdict(d) for d in data]
           else:
               output = asdict(data)
           print(json.dumps(output, indent=2, default=str))
           return 0

       # Format
       message = skill.format(data, platform=args.platform)

       # Send or print
       if args.send:
           result = await skill.send(message, channel="telegram",
                                     chat_id=args.chat_id, topic_id=args.topic_id)
           if result.success:
               print("✓ Message sent successfully", file=sys.stderr)
               return 0
           else:
               print(f"✗ Failed: {result.error}", file=sys.stderr)
               return 1
       else:
           print(message)
           return 0
   ```

4. **Update `WeatherSkill.send()`** if needed — ensure it passes through `chat_id` and `topic_id` kwargs to the underlying sender

5. **Delete dead code** (all of these functions):
   - `format_text()` (lines 132-172)
   - `fetch_weather()` (lines 175-229)
   - `_fetch_weather_direct()` (lines 232-297)
   - `_psr_to_percent()` (lines 300-309)
   - `_dict_to_weather_data()` (lines 312-356)
   - `_text_to_condition()` (lines 359-392)
   - `_hko_icon_to_condition()` (lines 395-453)
   - `send_telegram()` (lines 456-495)
   - The `ICON_MAP` dict inside `_hko_icon_to_condition()`

6. **Remove hardcoded chat ID** from argparse epilog (line 51)

**Verify:**
```bash
# These should all work after the rewrite:
python -m weather.cli --location "Hong Kong"          # HKO provider
python -m weather.cli --location "Tokyo"              # JMA provider (was broken)
python -m weather.cli --location "New York"            # NWS provider (was broken)
python -m weather.cli --location "Singapore"           # NEA provider (was broken)
python -m weather.cli --location "Hong Kong" --format json
python -m weather.cli --location "Hong Kong" --platform telegram
python -m weather.cli --location "Hong Kong" --forecast --days 5
```

---

### Task 1.5 — Update and run tests ✅

**Files:** `tests/test_cli_text_formatter.py` (new), `tests/test_bootstrap.py` (new), `tests/test_cli_integration.py` (new), `tests/test_telegram_sender.py` (new)
**Depends on:** 1.4
**Parallel:** no (gate — validates all of Phase 1)
**Completed:** 2026-04-17
**Result:** 4 new test files, 29 new tests. Total suite: 66 tests passing.

**Convention:** Follow existing pattern — `unittest.IsolatedAsyncioTestCase`, `@patch.object` at the HTTP-fetch boundary, assert on `WeatherData` properties. See `tests/test_batch1_providers.py` for reference.

**Step 0 — Run existing suite, fix breakage:**

```bash
python -m pytest tests/ -v
```

If `test_core.py` breaks (it references `WeatherSkill` + `HKOProvider` which are unchanged), investigate. Most likely nothing breaks here since we only changed `cli.py`, `bootstrap.py`, formatters, and sender — not providers or `skill.py`.

---

**Step 1 — Create `tests/test_cli_text_formatter.py`:**

```python
import unittest
from weather.models import WeatherData, WeatherCondition
from weather.formatters.cli_text import CliTextFormatter


class TestCliTextFormatter(unittest.TestCase):
    def setUp(self):
        self.formatter = CliTextFormatter()

    # --- format_current ---

    def test_format_current_all_fields(self):
        """All populated fields appear in output."""
        data = WeatherData(
            location="Tokyo",
            temperature=22.0,
            feels_like=24.0,
            humidity=65,
            temp_high=26.0,
            temp_low=18.0,
            wind_description="NE 12 km/h",
            precipitation_chance=30,
            uv_index=6.0,
            aqhi=3,
            condition=WeatherCondition.PARTLY_CLOUDY,
            provider_name="jma",
        )
        output = self.formatter.format_current(data)
        self.assertIn("Tokyo", output)
        self.assertIn("22°C", output)
        self.assertIn("24°C", output)          # feels_like
        self.assertIn("26°", output)            # temp_high
        self.assertIn("18°", output)            # temp_low
        self.assertIn("65%", output)            # humidity
        self.assertIn("NE 12 km/h", output)     # wind — this was broken before
        self.assertIn("30%", output)            # rain chance
        self.assertIn("6", output)              # uv_index
        self.assertIn("3", output)              # aqhi
        self.assertIn("jma", output)            # provider

    def test_format_current_minimal_fields(self):
        """Only required fields — no crash, no 'None' in output."""
        data = WeatherData(
            location="Unknown",
            temperature=20.0,
            condition=WeatherCondition.UNKNOWN,
        )
        output = self.formatter.format_current(data)
        self.assertIn("20°C", output)
        self.assertNotIn("None", output)

    def test_format_current_negative_temperature(self):
        """Negative temperatures format correctly."""
        data = WeatherData(
            location="Moscow",
            temperature=-5.0,
            condition=WeatherCondition.SNOW,
        )
        output = self.formatter.format_current(data)
        self.assertIn("-5°C", output)

    def test_format_current_aqi_fallback(self):
        """AQI appears when AQHI is absent."""
        data = WeatherData(
            location="LA",
            temperature=28.0,
            aqi=75,
            condition=WeatherCondition.SUNNY,
        )
        output = self.formatter.format_current(data)
        self.assertIn("75", output)

    # --- format_forecast ---

    def test_format_forecast_multi_day(self):
        """Multi-day forecast shows each day."""
        from datetime import date
        days = [
            WeatherData(
                location="Tokyo",
                temperature=18.0,
                temp_high=22.0,
                temp_low=15.0,
                condition=WeatherCondition.SUNNY,
                forecast_date=date(2026, 4, 15),
            ),
            WeatherData(
                location="Tokyo",
                temperature=16.0,
                temp_high=20.0,
                temp_low=14.0,
                condition=WeatherCondition.RAIN,
                forecast_date=date(2026, 4, 16),
            ),
        ]
        output = self.formatter.format_forecast(days)
        self.assertIn("22°", output)
        self.assertIn("15°", output)
        self.assertIn("20°", output)
        self.assertIn("14°", output)

    def test_format_forecast_empty(self):
        """Empty forecast list doesn't crash."""
        output = self.formatter.format_forecast([])
        self.assertIsInstance(output, str)

    # --- truncation ---

    def test_truncation_respected(self):
        """Output is truncated to max_length."""
        data = WeatherData(
            location="Test",
            temperature=20.0,
            description="x" * 5000,
            condition=WeatherCondition.UNKNOWN,
        )
        output = self.formatter.format_current(data)
        self.assertLessEqual(len(output), self.formatter.max_length)

    # --- platform property ---

    def test_platform_name(self):
        self.assertEqual(self.formatter.platform, "text")
```

---

**Step 2 — Create `tests/test_bootstrap.py`:**

```python
import os
import unittest
from unittest.mock import patch


class TestBuildDefaultSkill(unittest.TestCase):

    def test_free_providers_always_registered(self):
        """All 8 free providers are registered without any env vars."""
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        names = [p.name for p in skill.providers]
        for expected in ["hko", "sg_nea", "jma", "bom", "metservice",
                         "nws", "bmkg", "dwd"]:
            self.assertIn(expected, names, f"Missing free provider: {expected}")

    def test_formatters_registered(self):
        """text, telegram, whatsapp formatters present."""
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        self.assertIn("text", skill.platforms)
        self.assertIn("telegram", skill.platforms)
        self.assertIn("whatsapp", skill.platforms)

    @patch.dict(os.environ, {"OPENWEATHERMAP_API_KEY": "test-key"})
    def test_owm_registered_with_key(self):
        """OWM provider appears when env var is set."""
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        names = [p.name for p in skill.providers]
        self.assertIn("openweathermap", names)

    @patch.dict(os.environ, {}, clear=True)
    def test_owm_absent_without_key(self):
        """OWM provider absent when env var missing."""
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        names = [p.name for p in skill.providers]
        self.assertNotIn("openweathermap", names)

    @patch.dict(os.environ, {"CWA_API_KEY": "test-key"})
    def test_cwa_registered_with_key(self):
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        names = [p.name for p in skill.providers]
        self.assertIn("cwa", names)

    @patch.dict(os.environ, {"METOFFICE_API_KEY": "test-key"})
    def test_metoffice_registered_with_key(self):
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        names = [p.name for p in skill.providers]
        self.assertIn("metoffice", names)

    @patch.dict(os.environ, {"KMA_SERVICE_KEY": "test-key"})
    def test_kma_registered_with_key(self):
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        names = [p.name for p in skill.providers]
        self.assertIn("kma", names)

    @patch.dict(os.environ, {"TMD_API_TOKEN": "test-key"})
    def test_tmd_registered_with_key(self):
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        names = [p.name for p in skill.providers]
        self.assertIn("tmd", names)

    @patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:ABC"})
    def test_telegram_sender_registered_with_token(self):
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        self.assertIn("telegram", skill.channels)

    def test_telegram_sender_absent_without_token(self):
        from weather.bootstrap import build_default_skill
        with patch.dict(os.environ, {}, clear=True):
            skill = build_default_skill()
            self.assertNotIn("telegram", skill.channels)

    def test_providers_sorted_by_priority(self):
        """Providers are in priority order."""
        from weather.bootstrap import build_default_skill
        skill = build_default_skill()
        priorities = [p.priority for p in skill.providers]
        self.assertEqual(priorities, sorted(priorities))
```

---

**Step 3 — Create `tests/test_cli_integration.py`:**

```python
import unittest
from unittest.mock import patch, AsyncMock
from io import StringIO

from weather.models import WeatherData, WeatherCondition
from weather.cli import create_parser, main


class TestCLIIntegration(unittest.IsolatedAsyncioTestCase):
    """Integration tests: CLI → WeatherSkill → mocked provider → output."""

    def _parse(self, *cli_args):
        parser = create_parser()
        return parser.parse_args(list(cli_args))

    @patch("weather.bootstrap.HKOProvider.get_current", new_callable=AsyncMock)
    async def test_hk_current_text(self, mock_get):
        """CLI returns text output for Hong Kong."""
        mock_get.return_value = WeatherData(
            location="Hong Kong",
            temperature=27.0,
            humidity=82,
            wind_description="South force 3",
            condition=WeatherCondition.PARTLY_CLOUDY,
            provider_name="hko",
        )
        args = self._parse("--location", "Hong Kong")
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            code = await main(args)
        output = mock_out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("27°C", output)
        self.assertIn("82%", output)
        self.assertIn("South force 3", output)

    @patch("weather.bootstrap.JMAProvider.get_current", new_callable=AsyncMock)
    async def test_tokyo_routes_to_jma(self, mock_get):
        """Tokyo uses JMA, not HKO."""
        mock_get.return_value = WeatherData(
            location="Tokyo",
            temperature=22.0,
            condition=WeatherCondition.SUNNY,
            provider_name="jma",
        )
        args = self._parse("--location", "Tokyo")
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            code = await main(args)
        output = mock_out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("Tokyo", output)
        self.assertIn("jma", output)

    @patch("weather.bootstrap.NWSProvider.get_current", new_callable=AsyncMock)
    async def test_nyc_routes_to_nws(self, mock_get):
        """New York uses NWS."""
        mock_get.return_value = WeatherData(
            location="New York",
            temperature=18.0,
            condition=WeatherCondition.CLOUDY,
            provider_name="nws",
        )
        args = self._parse("--location", "New York")
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            code = await main(args)
        output = mock_out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("New York", output)

    @patch("weather.bootstrap.HKOProvider.get_current", new_callable=AsyncMock)
    async def test_json_output(self, mock_get):
        """--format json returns valid JSON with WeatherData fields."""
        mock_get.return_value = WeatherData(
            location="Hong Kong",
            temperature=25.0,
            condition=WeatherCondition.SUNNY,
            provider_name="hko",
        )
        args = self._parse("--location", "Hong Kong", "--format", "json")
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            code = await main(args)
        import json
        output = json.loads(mock_out.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(output["location"], "Hong Kong")
        self.assertEqual(output["temperature"], 25.0)

    @patch("weather.bootstrap.HKOProvider.get_forecast", new_callable=AsyncMock)
    async def test_forecast_output(self, mock_get):
        """--forecast returns multi-day output."""
        from datetime import date
        mock_get.return_value = [
            WeatherData(location="Hong Kong", temperature=24.0,
                        temp_high=28.0, temp_low=22.0,
                        condition=WeatherCondition.SUNNY,
                        forecast_date=date(2026, 4, 15)),
            WeatherData(location="Hong Kong", temperature=22.0,
                        temp_high=26.0, temp_low=20.0,
                        condition=WeatherCondition.RAIN,
                        forecast_date=date(2026, 4, 16)),
        ]
        args = self._parse("--location", "Hong Kong", "--forecast", "--days", "2")
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            code = await main(args)
        output = mock_out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("28°", output)
        self.assertIn("22°", output)

    @patch("weather.bootstrap.HKOProvider.get_current", new_callable=AsyncMock)
    async def test_telegram_format(self, mock_get):
        """--platform telegram produces MarkdownV2 output."""
        mock_get.return_value = WeatherData(
            location="Hong Kong",
            temperature=27.0,
            humidity=80,
            condition=WeatherCondition.PARTLY_CLOUDY,
            provider_name="hko",
        )
        args = self._parse("--location", "Hong Kong", "--platform", "telegram")
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            code = await main(args)
        output = mock_out.getvalue()
        self.assertEqual(code, 0)
        # TelegramFormatter escapes special chars
        self.assertIn("Hong Kong", output)

    async def test_send_without_token_fails(self):
        """--send without TELEGRAM_BOT_TOKEN returns error."""
        args = self._parse("--location", "Hong Kong", "--send")
        with patch.dict("os.environ", {}, clear=True):
            with patch("sys.stderr", new_callable=StringIO):
                code = await main(args)
        self.assertEqual(code, 1)
```

**Note for implementer:** The exact `@patch` target paths above (e.g., `weather.bootstrap.HKOProvider.get_current`) will depend on how `bootstrap.py` imports providers. Adjust the patch paths to match actual import locations. The pattern is: patch where the object is *used*, not where it's *defined*.

---

**Step 4 — Create `tests/test_telegram_sender.py`:**

```python
import unittest
from unittest.mock import patch, MagicMock
import json

from weather.senders.telegram import TelegramSender


class TestTelegramSenderSecurity(unittest.IsolatedAsyncioTestCase):

    async def test_no_subprocess_import(self):
        """TelegramSender should not use subprocess (security: token in ps)."""
        import inspect
        source = inspect.getsource(TelegramSender)
        self.assertNotIn("subprocess", source)

    async def test_no_curl_usage(self):
        """No curl in sender implementation."""
        import inspect
        source = inspect.getsource(TelegramSender)
        self.assertNotIn("curl", source)

    @patch("urllib.request.urlopen")
    async def test_send_uses_urllib(self, mock_urlopen):
        """Send uses urllib.request, not subprocess."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(
            {"ok": True, "result": {"message_id": 123}}
        ).encode()
        mock_resp.__enter__ = lambda s: mock_resp
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        sender = TelegramSender(bot_token="123:ABC", default_chat_id="-100")
        result = await sender.send("test message")

        self.assertTrue(result.success)
        mock_urlopen.assert_called_once()
```

---

**Step 5 — Verify everything:**

```bash
python -m pytest tests/ -v
```

All tests should pass. Confirm zero references to deleted functions:

```bash
grep -rn "fetch_weather\|_fetch_weather_direct\|format_text\|_dict_to_weather_data" tests/
```

---

## Phase 2: Security Hardening

### Task 2.1 — Remove duplicate OWM API call ✅

**File:** `weather/providers/openweathermap.py`
**Depends on:** nothing
**Parallel:** yes
**Completed:** 2026-04-17
**Result:** `_parse_current()` now extracts `coord` and sets `latitude`/`longitude` on `WeatherData`. `get_current_with_air_quality()` reads coords from the returned object instead of making a second API call.

**Steps:**

1. In `get_current_with_air_quality()` (line 176-207):
   - Remove the second `urlopen` call to the weather endpoint (lines 186-192)
   - Instead, have `get_current()` store `latitude`/`longitude` on the returned `WeatherData` from the first response's `coord` field
   - In `_parse_current()`, extract `data.get("coord", {})` and set `latitude`/`longitude` on `WeatherData`
   - In `get_current_with_air_quality()`, read coords from the returned `WeatherData`

**Verify:** One less HTTP call per `get_current_with_air_quality()` invocation.

---

### Task 2.2 — Switch KMA to HTTPS ✅

**File:** `weather/providers/kr_kma.py`
**Depends on:** nothing
**Parallel:** yes
**Completed:** 2026-04-17
**Result:** `KMA_BASE_URL` changed from `http://` to `https://`. Derived URLs (`KMA_FORECAST_URL`, `KMA_NOWCAST_URL`) pick up the change via f-string interpolation.

**Steps:**

1. Change line 23: `"http://apis.data.go.kr/..."` → `"https://apis.data.go.kr/..."`
2. Test that the endpoint accepts HTTPS (it does per data.go.kr docs)

---

### Task 2.3 — Remove hardcoded chat ID from help text ✅

**File:** `weather/cli.py`
**Completed:** Done by Task 1.4 rewrite (commit `54a8a21`). CLI epilog now uses `"YOUR_CHAT_ID"`. Parse_mode mismatch also resolved — old `send_telegram()` with `"Markdown"` was deleted; all sends use `TelegramSender` with `"MarkdownV2"`.

---

## Phase 3: Efficiency & Code Quality

### Task 3.1 — Replace deprecated `asyncio.get_event_loop()` ✅

**Files:** All provider files + `weather/senders/telegram.py`
**Depends on:** nothing
**Parallel:** yes
**Completed:** 2026-04-17
**Result:** 15 occurrences replaced with `asyncio.get_running_loop()` across 12 files. `grep` confirms zero remaining `get_event_loop` calls.

**Steps:**

1. In every file that calls `asyncio.get_event_loop()`, replace with `asyncio.get_running_loop()`
2. Files to update:
   - `weather/providers/hko.py` (line 110)
   - `weather/providers/sg_nea.py` (line 133)
   - `weather/providers/jma.py` (line 274)
   - `weather/providers/tw_cwa.py` (line 213)
   - `weather/providers/uk_metoffice.py` (line 205)
   - `weather/providers/au_bom.py` (lines 204, 222)
   - `weather/providers/nz_metservice.py` (line 184)
   - `weather/providers/us_nws.py` (lines 216, 235, 265)
   - `weather/providers/id_bmkg.py` (line 175)
   - `weather/providers/de_dwd.py` (line 186)
   - `weather/providers/kr_kma.py` (line 228)
   - `weather/providers/th_tmd.py` (line 178)
   - `weather/providers/openweathermap.py` (if any — uses sync urlopen directly)
   - `weather/senders/telegram.py` (line 138)

**Verify:**
```bash
grep -rn "get_event_loop" weather/  # should return 0 results after fix
python -m pytest tests/ -v
```

---

### Task 3.2 — Deduplicate `CONDITION_EMOJI` maps

**Files:** `weather/formatters/telegram.py`, `weather/formatters/whatsapp.py`
**Depends on:** nothing
**Parallel:** yes

**Steps:**

1. `weather/models.py` already defines `CONDITION_EMOJI` (line 37-58) — this is the canonical source
2. In `weather/formatters/telegram.py`:
   - Remove the local `CONDITION_EMOJI` dict (lines 34-49)
   - Import: `from ..models import CONDITION_EMOJI`
   - Update `get_condition_emoji()` to use the imported map
3. In `weather/formatters/whatsapp.py`:
   - Remove the local `CONDITION_EMOJI` dict (lines 15-30)
   - Import: `from ..models import CONDITION_EMOJI`
   - Update `get_condition_emoji()` to use the imported map
4. Check if the maps differ — if formatters have extra entries (e.g., `OVERCAST`), add those to `models.py`'s map

**Verify:**
```bash
grep -rn "CONDITION_EMOJI\s*=" weather/  # should only appear in models.py
python -m pytest tests/ -v
```

---

### Task 3.3 — Fix `SendResult.metadata` mutable default

**File:** `weather/senders/base.py`
**Depends on:** nothing
**Parallel:** yes

**Steps:**

1. Change line 23 from:
   ```python
   metadata: dict[str, Any] = None
   ```
   to:
   ```python
   metadata: Optional[dict[str, Any]] = field(default=None)
   ```
2. Ensure `field` is imported from `dataclasses` (already imported on line 7)

---

### Task 3.4 — Bump `requires-python` in `pyproject.toml`

**File:** `pyproject.toml`
**Depends on:** nothing
**Parallel:** yes

**Steps:**

1. Change line 10 from `requires-python = ">=3.8"` to `requires-python = ">=3.10"`
2. Rationale: code uses `dict | list` union syntax (Python 3.10+), `list[...]` generics without `from __future__ import annotations`

---

### Task 3.5 — Fix `_calculate_feels_like` wind_speed unit ambiguity

**File:** `weather/models.py`
**Depends on:** nothing
**Parallel:** yes

**Steps:**

1. In `_calculate_feels_like()` docstring (lines 210-213), the `wind_speed` parameter says "m/s" but `WeatherData.wind_speed` is documented as "km/h" (line 78)
2. The wind chill formula on line 224 treats input as m/s (`wind_speed > 1.33` which is 4.8 km/h) and converts to km/h on line 227 (`wind_speed * 3.6`)
3. The `effective_feels_like` property (line 194) passes `self.wind_speed` which is km/h
4. **Fix:** Either:
   - (a) Change the static method to accept km/h and remove the `* 3.6` conversion, adjusting the threshold to `> 4.8`, OR
   - (b) In `effective_feels_like`, convert km/h to m/s before passing: `wind = self.wind_speed / 3.6 if self.wind_speed else 0.0`
5. Option (b) is safer — it keeps the formula correct per NOAA spec (which uses m/s internally) and fixes the caller
6. Update the docstring to clarify the expected unit

---

## Phase 4: Cleanup & Documentation

### Task 4.1 — Delete remaining dead code ✅

**File:** `weather/cli.py`
**Completed:** Done by Task 1.4 rewrite (commit `54a8a21`). All 8 dead functions deleted. Verified via grep — zero references remain in `weather/` or `tests/`.

---

### Task 4.2 — Update documentation

**Files:** `docs/provider-selection.md`, `SKILL.md`, `README.md`
**Depends on:** Phase 1
**Parallel:** yes

**Steps:**

1. Update `docs/provider-selection.md` provider matrix to include BMKG, DWD, KMA, TMD (already partially there)
2. Update `SKILL.md` CLI usage section:
   - Document that `--provider auto` uses the full provider chain
   - List all available `--provider` values
   - Update `--platform` choices to include `text`, `telegram`, `whatsapp`
3. Update `README.md` if it references the old CLI behavior
4. Add `weather/bootstrap.py` to the file structure listing in `SKILL.md`
5. Add `weather/formatters/cli_text.py` to the file structure listing

---

## Summary

| Task | File(s) | Status | Parallelizable | Est. Effort |
|------|---------|--------|---------------|-------------|
| 1.1 | `formatters/cli_text.py` | ✅ | ✅ | Small |
| 1.2 | `bootstrap.py` | ✅ | ✅ | Small |
| 1.3 | `senders/telegram.py` | ✅ | ✅ | Small |
| 1.4 | `cli.py` | ✅ | ❌ (after 1.1-1.3) | Medium |
| 1.5 | `tests/` (4 new files) | ✅ | ❌ (after 1.4) | Medium |
| 2.1 | `providers/openweathermap.py` | ✅ | ✅ | Small |
| 2.2 | `providers/kr_kma.py` | ✅ | ✅ | Trivial |
| 2.3 | `cli.py` epilog | ✅ | — | — |
| 3.1 | All providers + sender (12 files) | ✅ | ✅ | Small |
| 3.2 | `formatters/telegram.py`, `whatsapp.py` | ✅ | ✅ | Trivial |
| 3.3 | `senders/base.py` | ✅ | ✅ | Trivial |
| 3.4 | `pyproject.toml` | ✅ | ✅ | Trivial |
| 3.5 | `models.py` | ✅ | ✅ | Small |
| 4.1 | `cli.py` | ✅ | — | — |
| 4.2 | `docs/`, `SKILL.md`, `README.md` | ✅ | ✅ | Small |

**All tasks complete. Test suite: 66 tests passing (37 existing + 29 new).**
