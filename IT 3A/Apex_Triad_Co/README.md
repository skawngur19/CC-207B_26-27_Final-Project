# Clinch Study Hub

A study-hub management system for **Clinch Study Hub, La Paz, Iloilo City**. It handles space reservations, point of sale, staff and careers, and an activity log. The project has two parts that share one Firebase database: a hosted website and a Windows desktop app for the owner.

**Live website:** https://clinch-demo.web.app

## Team

| Member | Responsibility |
|---|---|
| _Christian Paul De la Cruz_ | _e.g. Flutter UI and scan screen_ |
| _Kliu Maverick Villanueva_ | _e.g. Flutter core, data layer, AI logic_ |
| _Eliza May Calisa_ | _e.g. Website, Firebase hosting, repo setup_ |

## Project structure

```
Apex_Triad_Co/
├── README.md
├── .gitignore
├── website/                  Web app (HTML/JS/CSS), hosted on Firebase
│   ├── index.html
│   ├── 404.html
│   ├── api.js                Firebase Auth + Firestore data layer
│   ├── demo-api.js           Local demo data layer (no Firebase)
│   ├── app.js                App startup and routing
│   ├── views.js              Screens and UI templates
│   ├── domain.js             Shared business rules
│   ├── checkout.js           Point-of-sale checkout logic
│   ├── terminal.js           Offline terminal / failsafe logic
│   ├── terminal-storage.js   Offline terminal storage
│   ├── icons.js
│   ├── sw.js                 Service worker (offline shell)
│   ├── styles.css
│   ├── manifest.webmanifest
│   ├── firebase-config.js    Public Firebase web config
│   ├── firebase.json         Hosting settings
│   ├── .firebaserc           Firebase project alias
│   ├── firestore.rules       Firestore security rules
│   └── assets/
└── windows-app/              Flutter Windows app for the owner
    ├── lib/                  Main app code
    ├── core/                 Shared logic
    ├── data/                 Data layer
    ├── ui/                   Screens
    ├── backend/              Local shared server (demo)
    ├── windows/              Windows runner
    ├── test/
    ├── tool/
    ├── pubspec.yaml
    └── README.md             App-specific notes
```

## Roles

| Role | How the account is created | Access |
|---|---|---|
| Owner | Created manually in Firebase (Authentication user plus a `users/<UID>` document with `role: "owner"`) | Everything |
| Employee | Created by the owner in **Team & careers** | Point of sale, reservations, transactions |
| Customer | Registers on the website | Own reservations and job applications |

Passwords must be at least 12 characters.

## Data conventions (Firestore)

- Collections: `users`, `resources`, `products`, `bookings`, `slotLocks`, `sales`, `operations`, `applications`, `jobs`, `audit`, `terminalReviews`.
- **Money is stored in centavos.** PHP 85.00 is stored as `8500`.
- Product fields: `id`, `name`, `category`, `price`, `stock`. Use capitalized categories (`Drinks`, `Essentials`, `Snacks`).
- Resource fields: `type`, `rate` (centavos).
- Sales carry an `operationId` so a retried request never charges twice.

## Running the website

**With Firebase (live data):** open https://clinch-demo.web.app, or serve the `website/` folder locally.

**Local demo (no Firebase):** serve `website/` on localhost and open it with `?demo=1`, for example `http://localhost:5500/?demo=1`.

**Deploying** (needs access to the `clinch-demo` Firebase project):

```bash
cd website
npm install -g firebase-tools
firebase login
firebase deploy --only hosting
```

Security rules are published from the Firebase console and kept in `website/firestore.rules` for reference.

## Running the Windows app

Requirements: Flutter SDK, and Visual Studio 2022 with the "Desktop development with C++" workload.

```bash
cd windows-app
flutter doctor
flutter pub get
flutter run -d windows
```

## Status

- [x] Website and app logic
- [x] Local sync between website and app
- [x] Live hosting on Firebase
- [ ] Windows app connected to Firestore (live sync)
- [ ] AI receipt scanner (webcam barcode scan plus receipt verification)
- [ ] Polish

## Planned: AI receipt scanner

The owner scans a receipt's unique barcode with the PC webcam. The app looks up the purchase record, an AI model reads the receipt photo (total, date, items) and compares it with the record, and the app shows a verdict (match, mismatch, unknown, or already claimed) with a risk score. The AI API key is never stored in the website or the app. The call goes through a Firebase Cloud Function.

## Git workflow

- `main` holds the working version.
- Each member works on their own branch (`feature/<name>`) and merges through a pull request.
- Never commit `build/`, `.dart_tool/`, `.pub-cache/`, `.env`, service-account keys, `.exe`, or `.dll` files. Share builds as a GitHub Release.

## Security notes

- `firebase-config.js` is safe to commit. The web config is public by design, and Firestore security rules protect the data.
- Do not put any AI or third-party API key in the website or the Windows app.