# Wattwise

Wattwise is a local electricity bill estimator with account sign-in, per-account data, and SQLite persistence.

## Start the app

Use Node.js 22.13 or later. No npm packages need to be installed.

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000), create an account, and add appliances. Keep the server running while using the app. Opening `index.html` directly will not connect to the database.

The SQLite database is created at `data/wattwise.sqlite` the first time the server starts. Back up that file to back up local accounts and estimates. Database files are excluded from Git.

## Stored data

- Account name, email, and a salted PBKDF2 password hash
- Hashed, expiring sign-in sessions
- Appliance lists, electricity rate slabs, and previous bill amount
- One saved estimate per account per calendar month (saving again updates that month)

Accounts and data currently live on the computer running the server. This starter app does not include email verification, password reset, or hosted deployment configuration.
