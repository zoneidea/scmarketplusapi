# scmarketplusapi

Express API with Axios, MySQL, Firebase Cloud Messaging, and Firestore support.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `.env` with your MySQL credentials and Firebase Admin service account.

## Scripts

```bash
npm run dev
npm start
npm run check
```

## Endpoints

- `GET /health`
- `GET /health/uat`
- `POST /CreateTransactionPayment`
- `POST /api/payments/create-transaction`
- `POST /uat/CreateTransactionPayment`
- `POST /api/uat/payments/create-transaction`
- `POST /CallbackPaymentNotifyURL`
- `POST /api/payments/callback`
- `POST /uat/CallbackPaymentNotifyURL`
- `POST /api/uat/payments/callback`
- `POST /api/notifications/send`
- `PATCH /api/firestore/:collection/:documentId`
- `PATCH /api/booth-locks/:boothId/:date`
- `DELETE /api/booth-locks/:boothId/:date`
- `POST /api/booth-locks/expire-old`
- `GET /GetCartItem?member_id=:memberId`
- `GET /api/cart-items?member_id=:memberId`
- `GET /api/cart/items?member_id=:memberId`
- `GET /uat/GetCartItem?member_id=:memberId`
- `GET /api/uat/cart-items?member_id=:memberId`
- `GET /api/uat/cart/items?member_id=:memberId`

## Get Cart Items

The Node.js cart endpoint keeps the legacy PHP response fields. Send the member ID
as a query parameter.

```bash
curl "http://localhost:3000/GetCartItem?member_id=1"
```

Successful response contract:

```json
{
  "status": "success",
  "message": "",
  "data": {
    "Cart": [
      {
        "booking_id": "G32507000029",
        "bu_Name": "Building A",
        "mi_Name": "Market",
        "create_date": "2026-08-05 10:00:00",
        "status_id": "2",
        "status_name": "Pending",
        "checked": false,
        "booking_detail": []
      }
    ],
    "Charge": []
  }
}
```

Errors use HTTP `400` for a missing `member_id` and `500` for unexpected failures.
Request, response, and error logs are written to `logs/get-cart-item.log`.

## Payment Callback

`POST /CallbackPaymentNotifyURL` keeps the same callback path as the old PHP controller.

```json
{
  "code": 0,
  "msg": "OK",
  "message": "OK",
  "sign": "signature",
  "data": {
    "mch_order_no": "TRANS001",
    "result": "SUCCESS"
  }
}
```

## Create Transaction Payment

`POST /CreateTransactionPayment` keeps the same input parameters as the old PHP controller:

```json
{
  "booking_id": [123],
  "charge_id": [],
  "coupon_id": "",
  "amount": 100,
  "mb_Id": 1
}
```

Place Ksher private keys in `ksher_pay/` using the old filename format. For example, `mch44620` must use `ksher_pay/Mch44620_PrivateKey.pem`, and `mch44622` must use `ksher_pay/Mch44622_PrivateKey.pem`. The default `.env` value `KSHER_PRIVATE_KEY_DIR=./ksher_pay` already points to this folder.

## Send Notification

```json
{
  "token": "fcm-device-token",
  "title": "Order update",
  "body": "Your order has been updated",
  "data": {
    "orderId": 123
  }
}
```

Use `topic` instead of `token` to send to an FCM topic.

## Update Firestore

```bash
curl -X PATCH http://localhost:3000/api/firestore/users/user-001 \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Test User"}'
```

## Daily full database backup to Google Drive

Authenticated cron endpoint: `POST` or `GET /api/admin/backups/database` with
`Authorization: Bearer <BACKUP_API_TOKEN>`. Status: `GET /api/admin/backups/status`.
Full dumps are compressed, AES-256-GCM encrypted, uploaded to monthly Drive folders,
and verified. No Drive backup is deleted. Repeated calls on the same Bangkok date
reuse a verified backup. Configure an external cron at 02:00 Asia/Bangkok.

See [setup, API contract, OAuth, locking impact, and restore instructions](docs/database-backup.md).
**Configure OAuth credentials and encryption/token secrets before use.** The dump
uses a global read lock to include MyISAM consistently; writes wait during the dump.
