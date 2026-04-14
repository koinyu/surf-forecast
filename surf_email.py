#!/usr/bin/env python3
"""
Surf Forecast Email Script
==========================
Fetches 12-day wave & wind forecast from Open-Meteo (free, no API key)
and sends a surf report email via Gmail.

Setup:
  1. pip install requests
  2. Edit the CONFIG section below
  3. For Gmail: enable 2FA and create an App Password at
     https://myaccount.google.com/apppasswords
  4. Run: python3 surf_email.py
  5. To schedule daily: add to cron (see bottom of this file)
"""

import smtplib
import requests
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime, timezone

# ════════════════════════════════════════════════
#  CONFIG — edit these values
# ════════════════════════════════════════════════
CONFIG = {
    # Your surf spot
    "location_name": "Your Surf Spot",   # Display name
    "latitude":  35.3353,                # Decimal degrees
    "longitude": 139.9765,              # Decimal degrees (Chiba, Japan example)

    # Ideal conditions
    "min_wave_m":     0.5,   # Minimum wave height (meters)
    "max_wave_m":     2.0,   # Maximum wave height (meters)
    "max_wind_kn":   15.0,   # Max acceptable wind speed (knots)
    "min_period_s":   8.0,   # Minimum swell period (seconds)
    "beach_facing":   None,  # Beach orientation in degrees (0=N,90=E,180=S,270=W) or None

    # Email settings
    "send_to":   "koinuten@gmail.com",
    "send_from": "koinuten@gmail.com",  # Must be the Gmail account
    "app_password": "xxxx xxxx xxxx xxxx",  # Gmail App Password (not your login password!)
}

# ════════════════════════════════════════════════
#  API CALLS
# ════════════════════════════════════════════════
def fetch_marine(lat, lon):
    url = (
        f"https://marine-api.open-meteo.com/v1/marine?"
        f"latitude={lat}&longitude={lon}"
        f"&hourly=wave_height,wave_direction,wave_period,"
        f"swell_wave_height,swell_wave_direction,swell_wave_period"
        f"&forecast_days=16&timezone=auto"
    )
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    return r.json()


def fetch_weather(lat, lon):
    url = (
        f"https://api.open-meteo.com/v1/forecast?"
        f"latitude={lat}&longitude={lon}"
        f"&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m"
        f"&daily=sunrise,sunset,precipitation_sum"
        f"&forecast_days=16&timezone=auto"
    )
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    return r.json()


def parse_hour_frac(iso_str):
    """Parse '2024-06-01T05:23' into fractional hours (5.383...)"""
    if not iso_str:
        return None
    h = int(iso_str[11:13])
    m = int(iso_str[14:16])
    return h + m / 60


def fmt_hhmm(iso_str):
    """Extract HH:MM from ISO datetime string."""
    if not iso_str:
        return '—'
    return iso_str[11:16]


# ════════════════════════════════════════════════
#  HELPERS
# ════════════════════════════════════════════════
def kmh_to_knots(kmh):
    return kmh * 0.539957


def deg_to_compass(deg):
    dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
            'S','SSW','SW','WSW','W','WNW','NW','NNW']
    return dirs[round(deg / 22.5) % 16]


def wind_type(wind_dir_deg, beach_facing):
    if beach_facing is None:
        return None
    offshore_from = (beach_facing + 180) % 360
    diff = abs(wind_dir_deg - offshore_from)
    angle = min(diff, 360 - diff)
    if angle <= 45:  return 'offshore'
    if angle <= 90:  return 'cross-off'
    if angle <= 135: return 'cross-on'
    return 'onshore'


def score_hour(wave_h, wind_kn, period, wind_dir, cfg):
    score = 0
    # Wave height (0-40)
    if cfg['min_wave_m'] <= wave_h <= cfg['max_wave_m']:
        mid = (cfg['min_wave_m'] + cfg['max_wave_m']) / 2
        spread = (cfg['max_wave_m'] - cfg['min_wave_m']) / 2 or 0.1
        dist = abs(wave_h - mid) / spread
        score += round(40 * (1 - dist * 0.4))
    elif wave_h < cfg['min_wave_m']:
        score += round(40 * (wave_h / cfg['min_wave_m']) * 0.4)
    else:
        score += max(0, round(40 * (1 - (wave_h - cfg['max_wave_m']) / cfg['max_wave_m'] * 0.8)))
    # Wind speed (0-30)
    if wind_kn <= cfg['max_wind_kn']:
        score += round(30 * (1 - wind_kn / cfg['max_wind_kn'] * 0.4))
    else:
        score += max(0, round(30 * (1 - (wind_kn - cfg['max_wind_kn']) / cfg['max_wind_kn'])))
    # Wind direction (0-20)
    if cfg['beach_facing'] is not None:
        wt = wind_type(wind_dir, cfg['beach_facing'])
        pts = {'offshore': 20, 'cross-off': 14, 'cross-on': 6, 'onshore': 0}
        score += pts.get(wt, 0)
    else:
        score += 12
    # Swell period (0-10)
    if period >= cfg['min_period_s']:
        score += 10
    else:
        score += round(10 * period / cfg['min_period_s'])
    return min(100, max(0, score))


# ════════════════════════════════════════════════
#  PROCESS FORECAST
# ════════════════════════════════════════════════
def process_forecast(marine, weather, cfg):
    times = marine['hourly']['time']

    # ── Build sunrise/sunset map ─────────────────────────────────────
    sun_map = {}
    if weather.get('daily') and weather['daily'].get('time'):
        for i, date in enumerate(weather['daily']['time']):
            rise_str = weather['daily']['sunrise'][i]
            set_str  = weather['daily']['sunset'][i]
            rain_mm = 0
            if weather['daily'].get('precipitation_sum'):
                rain_mm = weather['daily']['precipitation_sum'][i] or 0
            sun_map[date] = {
                'rise_str':  rise_str,
                'set_str':   set_str,
                'rise_frac': parse_hour_frac(rise_str) or 6.0,
                'set_frac':  parse_hour_frac(set_str)  or 19.0,
                'rain_mm':   rain_mm,
            }

    # ── Build weather lookup by time string ──────────────────────────
    wtimes = weather['hourly']['time']
    weather_map = {
        wtimes[i]: {
            'wind_kn':  kmh_to_knots(weather['hourly']['wind_speed_10m'][i] or 0),
            'wind_dir': weather['hourly']['wind_direction_10m'][i] or 0,
            'gust_kn':  kmh_to_knots(weather['hourly']['wind_gusts_10m'][i] or 0),
        }
        for i in range(len(wtimes))
    }

    by_date = {}
    for i, t in enumerate(times):
        date = t[:10]
        hour = int(t[11:13])
        w = weather_map.get(t, {})

        wave_h   = marine['hourly']['wave_height'][i]
        period   = marine['hourly']['wave_period'][i]
        wave_dir = marine['hourly']['wave_direction'][i]
        swell_h  = marine['hourly']['swell_wave_height'][i]
        wind_kn  = w.get('wind_kn', 0)
        wind_dir = w.get('wind_dir', 0)
        gust_kn  = w.get('gust_kn', 0)

        if wave_h is None or period is None:
            continue

        score = score_hour(wave_h, wind_kn, period, wind_dir, cfg)

        by_date.setdefault(date, []).append({
            'hour': hour, 'wave_h': wave_h, 'period': period,
            'wave_dir': wave_dir, 'swell_h': swell_h or 0,
            'wind_kn': wind_kn, 'wind_dir': wind_dir, 'gust_kn': gust_kn,
            'score': score,
        })

    today_str = datetime.now().strftime('%Y-%m-%d')
    days = []
    for date in sorted(by_date.keys())[:12]:
        all_hrs = by_date[date]
        if not all_hrs:
            continue

        # Get sun times for this date (fall back to 6:00 / 19:00)
        sun = sun_map.get(date, {'rise_str': None, 'set_str': None, 'rise_frac': 6.0, 'set_frac': 19.0})

        # Keep only daylight hours (hour slot must overlap with daylight)
        hrs = [h for h in all_hrs
               if (h['hour'] + 1) > sun['rise_frac'] and h['hour'] < sun['set_frac']]

        # Fall back to all hours if polar night or missing sun data
        if not hrs:
            hrs = all_hrs

        avg_wave   = sum(h['wave_h']  for h in hrs) / len(hrs)
        max_wave   = max(h['wave_h']  for h in hrs)
        min_wave   = min(h['wave_h']  for h in hrs)
        avg_wind   = sum(h['wind_kn'] for h in hrs) / len(hrs)
        avg_period = sum(h['period']  for h in hrs) / len(hrs)
        avg_winddir= sum(h['wind_dir']for h in hrs) / len(hrs)
        avg_swellh = sum(h['swell_h'] for h in hrs) / len(hrs)
        day_score  = sum(h['score']   for h in hrs) / len(hrs)

        # Best consecutive 4-hour window within daylight
        best_window, best_ws = None, -1
        for j in range(len(hrs) - 3):
            ws = sum(h['score'] for h in hrs[j:j+4]) / 4
            if ws > best_ws:
                best_ws = ws
                best_window = hrs[j]

        rain_mm = sun.get('rain_mm', 0)
        # Heavy rain caps score (>10mm = poor regardless of surf)
        capped_score = min(day_score, 30) if rain_mm > 10 else day_score

        days.append({
            'date': date,
            'is_today': date == today_str,
            'avg_wave': avg_wave,
            'max_wave': max_wave,
            'min_wave': min_wave,
            'avg_wind': avg_wind,
            'avg_period': avg_period,
            'avg_winddir': avg_winddir,
            'avg_swellh': avg_swellh,
            'day_score': capped_score,
            'raw_score': day_score,
            'best_hour': best_window['hour'] if best_window else None,
            'sunrise': sun['rise_str'],
            'sunset':  sun['set_str'],
            'rain_mm': rain_mm,
        })
    return days


# ════════════════════════════════════════════════
#  BUILD EMAIL HTML
# ════════════════════════════════════════════════
def rating(score):
    if score >= 68: return ('great',  '🟢 Great',   '#10b981', '#d1fae5')
    if score >= 45: return ('decent', '🟡 Decent',  '#f59e0b', '#fef3c7')
    return              ('poor',   '🔴 Poor',    '#ef4444', '#fee2e2')


def build_html_email(days, cfg):
    generated = datetime.now().strftime('%B %d, %Y at %H:%M')
    great_days = [d for d in days if d['day_score'] >= 68]

    best_section = ''
    if great_days:
        def best_time_str(d):
            if d['best_hour'] is not None:
                return f", best {d['best_hour']}:00\u2013{d['best_hour']+4}:00"
            return ''
        items = ''.join(
            f"<li style='margin:4px 0;'><strong>{datetime.strptime(d['date'],'%Y-%m-%d').strftime('%A, %B %d')}</strong> "
            f"\u2014 {d['min_wave']:.1f}\u2013{d['max_wave']:.1f}m, {d['avg_wind']:.0f}kn wind"
            f"{best_time_str(d)}</li>"
            for d in great_days
        )
        best_section = f"""
        <div style="background:#d1fae5;border-left:4px solid #10b981;padding:14px 18px;border-radius:0 8px 8px 0;margin:20px 0;">
          <strong style="color:#065f46;">✅ Best Days to Surf:</strong>
          <ul style="margin:8px 0 0 0;padding-left:18px;color:#065f46;">{items}</ul>
        </div>"""

    rows = ''
    for d in days:
        cls, label, color, bg = rating(d['day_score'])
        dt = datetime.strptime(d['date'], '%Y-%m-%d')
        weekday = dt.strftime('%a')
        date_fmt = dt.strftime('%b %d')
        today_tag = '<span style="background:#dbeafe;color:#1d4ed8;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;">TODAY</span>' if d['is_today'] else ''
        compass = deg_to_compass(d['avg_winddir'])
        wt = wind_type(d['avg_winddir'], cfg['beach_facing'])
        wt_tag = {'offshore':'✅ Offshore','cross-off':'↗ Cross-off','cross-on':'↙ Cross-on','onshore':'🚫 Onshore'}.get(wt,'') if wt else ''
        best_time = f"{d['best_hour']}:00–{d['best_hour']+4}:00" if d['best_hour'] is not None else '—'

        rise_str = fmt_hhmm(d.get('sunrise'))
        set_str  = fmt_hhmm(d.get('sunset'))
        sun_str  = f"{rise_str} – {set_str}" if rise_str != '—' else '—'

        rows += f"""
        <tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:10px 12px;white-space:nowrap;">{weekday} {today_tag}<br><span style="font-size:12px;color:#64748b;">{date_fmt}</span></td>
          <td style="padding:10px 12px;"><span style="background:{bg};color:{color};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;">{label}</span></td>
          <td style="padding:10px 12px;">{d['min_wave']:.1f}–{d['max_wave']:.1f} m</td>
          <td style="padding:10px 12px;">{d['avg_period']:.0f} s</td>
          <td style="padding:10px 12px;">{d['avg_wind']:.0f} kn</td>
          <td style="padding:10px 12px;font-size:12px;">{compass} {wt_tag}</td>
          <td style="padding:10px 12px;font-size:12px;color:#64748b;">{best_time}</td>
          <td style="padding:10px 12px;font-size:12px;color:#b45309;">☀️ {sun_str}</td>
          <td style="padding:10px 12px;font-size:12px;">{"🚫 Heavy" if d["rain_mm"] > 10 else "⚠️ Light" if d["rain_mm"] > 3 else "✅ Dry"} {d["rain_mm"]:.1f}mm</td>
        </tr>"""

    conditions = (
        f"Waves: {cfg['min_wave_m']}–{cfg['max_wave_m']}m &nbsp;|&nbsp; "
        f"Wind: &lt;{cfg['max_wind_kn']}kn &nbsp;|&nbsp; "
        f"Period: &gt;{cfg['min_period_s']}s"
    )

    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0a1628,#0d2a4a);padding:28px 32px;text-align:center;">
    <div style="font-size:2.5rem;">🏄</div>
    <h1 style="color:#e0f2fe;margin:8px 0 4px;font-size:1.5rem;">Surf Forecast</h1>
    <p style="color:#94a3b8;margin:0;font-size:0.9rem;">📍 {cfg['location_name']}</p>
    <p style="color:#64748b;margin:6px 0 0;font-size:0.78rem;">Generated {generated}</p>
  </div>

  <div style="padding:24px 28px;">

    <!-- Conditions summary -->
    <div style="background:#f1f5f9;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:0.83rem;color:#475569;">
      Your ideal conditions: {conditions}
    </div>

    <!-- Best days callout -->
    {best_section}

    <!-- Forecast table -->
    <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
      <thead>
        <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Day</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Rating</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Waves</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Period</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Wind</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Direction</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Best Time</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Daylight</th>
          <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">Rain</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>

  </div>

  <!-- Footer -->
  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;text-align:center;font-size:0.75rem;color:#94a3b8;">
    Data: Open-Meteo Marine &amp; Weather API (free, no API key required)<br>
    <a href="https://open-meteo.com" style="color:#0ea5e9;">open-meteo.com</a>
  </div>
</div>
</body></html>"""


# ════════════════════════════════════════════════
#  SEND EMAIL
# ════════════════════════════════════════════════
def send_email(html_body, cfg):
    msg = MIMEMultipart('alternative')
    loc = cfg['location_name']
    msg['Subject'] = f"🏄 Surf Forecast — {loc} ({datetime.now().strftime('%b %d')})"
    msg['From']    = cfg['send_from']
    msg['To']      = cfg['send_to']

    # Plain text fallback
    plain = f"Surf Forecast for {loc}\nGenerated: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\nOpen in HTML-capable email client for full report."
    msg.attach(MIMEText(plain, 'plain'))
    msg.attach(MIMEText(html_body, 'html'))

    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
        server.login(cfg['send_from'], cfg['app_password'])
        server.sendmail(cfg['send_from'], cfg['send_to'], msg.as_string())


# ════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════
def main():
    print(f"🌊 Fetching surf forecast for {CONFIG['location_name']}…")
    marine  = fetch_marine(CONFIG['latitude'], CONFIG['longitude'])
    weather = fetch_weather(CONFIG['latitude'], CONFIG['longitude'])

    print("📊 Processing forecast data…")
    days = process_forecast(marine, weather, CONFIG)

    great = sum(1 for d in days if d['day_score'] >= 68)
    decent = sum(1 for d in days if 45 <= d['day_score'] < 68)
    poor   = sum(1 for d in days if d['day_score'] < 45)
    print(f"   Results: {great} great days 🟢 | {decent} decent 🟡 | {poor} poor 🔴")

    print("📧 Building email…")
    html = build_html_email(days, CONFIG)

    if CONFIG['app_password'] == 'xxxx xxxx xxxx xxxx':
        print("⚠️  No Gmail App Password set. Saving email to 'forecast_email.html' instead.")
        with open('forecast_email.html', 'w') as f:
            f.write(html)
        print("   Saved to forecast_email.html — open it in your browser to preview.")
    else:
        print(f"📤 Sending email to {CONFIG['send_to']}…")
        send_email(html, CONFIG)
        print("✅ Email sent!")

    print("\n📅 Quick summary:")
    for d in days:
        _, label, _, _ = rating(d['day_score'])
        dt = datetime.strptime(d['date'], '%Y-%m-%d')
        today_tag = " ← TODAY" if d['is_today'] else ""
        print(f"   {dt.strftime('%a %b %d')}: {label}  {d['min_wave']:.1f}–{d['max_wave']:.1f}m | {d['avg_wind']:.0f}kn{today_tag}")


if __name__ == '__main__':
    main()

# ════════════════════════════════════════════════
#  SCHEDULING (optional)
# ════════════════════════════════════════════════
# To run automatically every morning at 6am, add to crontab:
#   crontab -e
#   0 6 * * * /usr/bin/python3 /path/to/surf_email.py >> /tmp/surf_forecast.log 2>&1
#
# Or on macOS with launchd, or Windows Task Scheduler.
