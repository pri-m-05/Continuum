# Continuum Doc Assistant

A Chrome extension + FastAPI backend that:

- captures user actions in the browser
- turns those actions into documentation drafts
- checks drafts against audit rules
- lets users search existing docs
- suggests automation ideas when a process repeats

## Run the backend

From `backend/`:

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload