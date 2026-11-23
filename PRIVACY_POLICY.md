# CompanionDesk Privacy Policy (draft)

Last updated: October 24, 2026.

CompanionDesk is a local-first study assistant.

- **We collect nothing.** CompanionDesk has no accounts, no analytics, no
  telemetry, and no servers. The developer operates no backend that receives
  your data.
- **Your data stays with you.** Syllabi, extracted assignments, deadlines you
  add, settings, and the activity log below are stored on your device: a
  SQLite database and a markdown folder you own. Deleting the app's data
  erases everything permanently.
- **What it remembers about you.** Things you tell the assistant live in a
  plain markdown file on your device (`_about-me.md`). You can read, edit or
  delete any line. Suggestions to remember something are made by the local
  model only and saved only if you accept them.
- **Voice.** If you use the Speak button, your voice is recorded in memory,
  converted to text by a program on your device (whisper.cpp), and the
  recording is deleted immediately. It is never sent anywhere.
- **Window questions.** If you click Screen and pick a window, one screenshot
  of only that window is taken, handed to a local model on your device, and
  discarded. You see a preview and the window's title while it is sent. It is
  never saved or sent anywhere, and the cloud fallback is never used for
  screenshots. Windows that look like password managers or sign-in forms cannot
  be chosen, but this is a title check and is not complete protection.
- **Calendar.** A calendar file you import is stored on your device only and
  is shown to the local model, never to the cloud fallback.
- **Grades.** Scores and target grades you enter are stored on your device
  only and are never sent anywhere.
- **Activity log.** When you mark an item done, the app records which item
  and when, on your device only, to work out how early you usually finish.
  You can turn this off or clear it in the app at any time.
- **AI processing you control.** By default the app asks a local model running
  on your own machine (Ollama), which sends nothing anywhere. If you add your
  own Google Gemini API key as an opt-in fallback, nothing is sent to Google
  automatically: after a local failure, the app asks you to confirm it for
  that one question, and the confirmation states exactly what would be sent.
  By default that is a minimized prompt: your question, the assistant rules,
  and your course and due-date context; your calendar entries, your name,
  saved memories and activity habits are NOT sent. If you switch on the
  setting that shares full personal context, those categories may be sent,
  and the confirmation names them before you decide. Your conversation
  history and any screenshots are never sent to Google in either mode, and
  syllabus import and screen questions never use the cloud at all. The app
  works fully without any key.
- **No third-party trackers.** The app loads no advertising or tracking code.
- **Children.** CompanionDesk is a study tool intended for students and does
  not knowingly collect personal information from anyone, because it collects
  no information at all.
- **Contact.** Questions: the project's repository maintainer.

Note for the owner: both stores require this policy to be reachable at a
public URL before review; host it (e.g. GitHub Pages of the private repo is
not public — use any static host) and paste the link into the store forms.
