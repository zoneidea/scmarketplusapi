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
- `POST /CallbackPaymentNotifyURL`
- `POST /api/payments/callback`
- `POST /api/notifications/send`
- `PATCH /api/firestore/:collection/:documentId`
- `PATCH /api/booth-locks/:boothId/:date`
- `DELETE /api/booth-locks/:boothId/:date`
- `POST /api/booth-locks/expire-old`

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
