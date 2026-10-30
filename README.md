# PUP TOGETHER

A student hub with a login system, activities from professors, a class board, private messages, study groups, tasks, events, and dark mode.

## Files

| File | What it is |
| --- | --- |
| `server.js` | The server. Stores accounts, posts, and messages. |
| `index.html` | The whole website (design and behavior). |
| `pup-logo.png` | The PUP seal shown on the login page, sidebar, and ID card. |
| `package.json` | Lets you start the server with `npm start`. |
| `data.json` | Created automatically the first time the server runs. **This is your database. Back it up.** |

## Run it

1. Install Node.js 18 or newer from https://nodejs.org (one time).
2. Open a terminal in this folder and run:

```
node server.js
```

3. Open http://localhost:3000 in your browser.

There is nothing else to install.

## Your admin account

The first time the server starts, it creates this account:

| | |
| --- | --- |
| Full name | Antoine James Camaganakan |
| Username | `james` (capital letters do not matter) |
| Student ID | 2026-00183-TG-0 |
| Role | Admin (full access) |

The password is the one you gave me. It is saved as a scrambled (hashed) value, never as plain text in the code.
**After your first login, tap your name at the top, then "Change password", and pick a new one.** The old password was typed in a chat, so treat it as used.

## How to add other accounts

There are two ways. Use either one, or both.

### Way 1: You add them (you stay in control)

1. Log in as `james`.
2. Open **Accounts** in the left menu (on a phone, tap the menu button first).
3. Tap **Add account**.
4. Fill in the full name, a username, the student ID, the role (Student, Professor, or Admin), and a first password.
5. Tap **Create account**. Send the person the website link, their username, and that password.
6. They log in, tap their name at the top, and choose **Change password**.

Tip: turn **Open sign-ups** off (Accounts page) if you only want people you added to get in.

### Way 2: Students sign up themselves

Leave **Open sign-ups** on. A student taps **Sign up**, then enters their full name, **student ID** (like `2026-00183-TG-0`), a username, and a password. Each student ID and username can only be used once.

### Professors

Professors cannot sign up on their own. Add them yourself with the role **Professor** (Way 1). Professors and admins can post **Activities**, and they can delete any post on the board.

## Managing accounts (admin only)

On the **Accounts** page you can:

- **Search** by name, username, or student ID.
- **Edit** (pencil icon): change the name, student ID, role, or set a new password for someone who forgot theirs. Setting a new password logs that person out everywhere.
- **Remove** (trash icon): deletes the account. The person is logged out right away, they cannot log in again, and their private messages are deleted. Their public posts stay on the board under "Former member".
- **Open sign-ups** switch: opens or closes self sign-up.

Safety rules built in: you cannot remove your own account, and the last remaining admin cannot be removed or demoted, so you can never lock yourself out.

## Roles

| Role | Can do |
| --- | --- |
| Student | Read activities and tick them off, post on the board, send messages, use planner, groups, and events. |
| Professor | Everything a student can, plus post activities and delete any post. |
| Admin | Everything a professor can, plus the Accounts page. |

Student IDs are visible only to the admin and to the person who owns the account. Classmates see names only.

## Putting it online

The site needs its Node server and a place to save `data.json`. That means a **static host (like plain Vercel or GitHub Pages will not work)**.

- **Same Wi-Fi (quickest):** run `node server.js` on a computer and share `http://<that computer's address>:3000`.
- **Temporary public link:** run the server, then use a tunnel such as Cloudflare Tunnel or ngrok.
- **Always online:** use a host that runs Node.js and keeps a **persistent disk** (for example a small VPS, or Render/Railway with a disk or volume). Set `DATA_FILE` to a path on that disk.

Warning: many free hosts erase files when they restart. If `data.json` is erased, all accounts and posts are lost. Download a copy of `data.json` regularly.

## Optional settings

Set these as environment variables before `node server.js`:

| Name | What it does |
| --- | --- |
| `PORT` | Port number (default 3000). |
| `DATA_FILE` | Where to save the database (default `./data.json`). |
| `PROFESSOR_CODE` | Lets professors sign up themselves with this secret code. Leave it out to keep professor accounts admin-only. |

## Notes

- Tasks, study groups, and events are personal: they are saved in each person's own browser, not on the server.
- Activities, board posts, and messages are shared and update on everyone's screen within a few seconds.
- This is a student-made project and not an official PUP website. The footer says so. Keep that line if you use the PUP seal.
