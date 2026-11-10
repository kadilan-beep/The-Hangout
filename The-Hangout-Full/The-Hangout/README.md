# The Hangout

The full Hangout (feed, topics, chats, groups, friends, study zone, arcade, memes, polls, badges, themes, plans and video calls),
running on Firebase with email sign-in.

Files:
- index.html: the whole Hangout
- hangout-firebase.js: connects it to Firebase and adds email sign-in, photo uploads and alerts
- config.js: your Firebase settings (project hangout-app-3dd93)
- sw.js, manifest.json, icon-*.png: let people install it as an app

The security rules live in Firebase (Firestore Database → Rules), not in this folder.
