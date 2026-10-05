# VISHAL QX Live Telegram Ads Dashboard

A Railway-ready Node.js + PostgreSQL app for:

Meta/Facebook/Instagram ad -> Systeme.io landing page -> Telegram join request -> live dashboard.

## What it tracks

- Landing-page visits
- Telegram button clicks
- Telegram join requests
- Pending / approved / left / removed member states
- Telegram username, name, user ID and timestamps
- Invite-link source such as Facebook Ads / Instagram Ads
- Today / Yesterday / 7 days / 30 days / All time
- Live dashboard updates using Server-Sent Events
- Admin approval/rejection buttons for join requests

## Important privacy/security notes

Never commit `.env` or your Telegram bot token to GitHub.

The dashboard is protected by `ADMIN_PASSWORD`.

## 1. GitHub

Upload the contents of this folder to a private GitHub repository, for example:

`vishal-qx-dashboard`

## 2. Railway

Create two services in the same Railway project:

- `Postgres`
- `vishal-qx-dashboard`

Connect the Node service to this GitHub repository.

Add these variables in Railway:

```
BOT_TOKEN=your BotFather token
ADMIN_PASSWORD=a strong dashboard password
COOKIE_SECRET=a long random secret
TELEGRAM_WEBHOOK_SECRET=another long random secret
PUBLIC_URL=https://your-railway-domain
DATABASE_URL=${{Postgres.DATABASE_URL}}
CHANNEL_NAME=VISHAL QX
```

You can leave `CHANNEL_ID`, `FACEBOOK_INVITE_LINK`, and `INSTAGRAM_INVITE_LINK` empty at first.

After the service deploys, Railway will expose a public HTTPS URL. Put that URL in `PUBLIC_URL` and redeploy.

## 3. Telegram bot

The bot must be an administrator of the VISHAL QX channel with permission to invite/add subscribers.

The app automatically calls Telegram `setWebhook` on startup using:

`PUBLIC_URL/webhook/telegram`

The webhook listens for:

- `chat_join_request`
- `chat_member`
- `my_chat_member`

The channel ID can be auto-discovered when the first relevant Telegram update arrives.

## 4. Create ad invite links

Open:

`https://YOUR-RAILWAY-DOMAIN/admin`

Log in with `ADMIN_PASSWORD`.

Use the invite-link panel to create:

- `Facebook Ads`
- `Instagram Ads`

The app creates join-request invite links through Telegram. These links are distinct, so the dashboard can attribute requests to the source.

Use the resulting links for your Systeme.io funnel.

## 5. Systeme.io tracking

Your Systeme.io page can keep its current design. Add the contents of:

`public/systemeio-snippet.js`

to the page's custom JavaScript/HTML section.

Before adding the snippet, replace:

`https://YOUR-RAILWAY-DOMAIN`

with your actual Railway URL.

The snippet:

- records page visits
- detects Facebook / Instagram from UTM parameters and common click IDs
- records the click
- routes Telegram links through the backend
- sends users to the correct source-specific join-request invite link

Recommended Meta URL parameters:

`utm_source={{site_source_name}}&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`

If your Meta account uses different dynamic parameter support, you can set fixed `utm_source=facebook` or `utm_source=instagram` per ad.

## 6. Test

1. Open the Systeme.io page.
2. Click Join Telegram.
3. Submit a Telegram join request.
4. Open `/admin`.
5. Confirm a new Pending request appears.
6. Approve it from Telegram or the dashboard.
7. Confirm it changes to Joined.

## Routes

- `/` - login
- `/login` - login page
- `/admin` - live dashboard
- `/api/dashboard` - protected dashboard data
- `/api/events` - protected SSE stream
- `/api/admin/invites` - protected invite list
- `/api/admin/create-invite` - create Telegram invite
- `/api/admin/approve/:id` - approve a join request
- `/api/admin/decline/:id` - decline a join request
- `/api/track/visit` - landing-page visit tracking
- `/api/track/click` - Telegram button-click tracking
- `/go` - source-aware redirect to the correct Telegram invite
- `/webhook/telegram` - Telegram webhook
- `/health` - health check
