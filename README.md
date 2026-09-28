# 우리 소식 — 포스트잇 담벼락

FastAPI + SQLite 로 만든 학급 게시판. 급식(NEIS), 좋아요, 검열, 로그인이 들어 있다.

## 왜 GitHub Pages 로는 안 되나

GitHub Pages 는 파일을 그대로 내려주기만 하고 파이썬을 실행하지 않는다.
글을 한곳에 모으려면 **항상 켜져 있는 서버**가 필요하다.

- `docs/index.html` — 서버 없이 도는 혼자 연습용. 글이 그 브라우저에만 남는다.
- `static/index.html` — 진짜 담벼락. 아래처럼 서버에 올려야 다 같이 보인다.

## 올리는 법 (Render, 무료)

1. 저장소는 이미 올라가 있다 → <https://github.com/jeongseolab/woori-sosik>
2. <https://render.com> 가입(**Sign in with GitHub** 를 쓰면 편하다) →
   **New** → **Web Service** → `woori-sosik` 고르기.
3. `render.yaml` 이 있으니 설정은 자동으로 잡힌다. 확인만 한다.
   - Build: `pip install -r requirements.txt`
   - Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. **Environment** 에서 `MEMO_ADMIN_KEY` 에 관리자 비밀번호를 넣는다.
   (이게 admin 계정의 비밀번호가 된다)
5. Deploy. `https://이름.onrender.com` 주소가 나오면 그걸 나눠 준다.

### 꼭 확인할 것

- **디스크**: `render.yaml` 에 디스크가 잡혀 있다. 이게 없으면 서버가 쉬었다 깨어날 때마다 글이 전부 사라진다.
- **첫 접속이 느린 것**: 무료 요금제는 15분 안 쓰면 잠든다. 다시 깨는 데 30초쯤 걸린다. 발표 직전에 한 번 열어 두면 된다.

## 내 컴퓨터에서 돌리기

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

`http://127.0.0.1:8000` 으로 접속. 관리자 비밀번호는 `admin_key.txt` 에 있다.

## 계정

- **게스트** — 로그인 없이 쓴다. 자기 글은 그 브라우저에서만 뗄 수 있다.
- **학생 계정** — 가입하면 다른 기기에서도 자기 글을 관리한다.
- **admin** — 모든 글을 떼고 고칠 수 있다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `main.py` | API (메모, 좋아요, 로그인) |
| `auth.py` | 계정과 로그인. 비밀번호는 해시로 저장 |
| `censor.py` | 욕설 검열. 영타·자음·늘려쓰기 우회까지 막는다 |
| `database.py` | SQLite 연결과 표 만들기 |
| `meal.py` | NEIS 급식 불러오기 |
| `static/index.html` | 화면 전체 |

## 올리면 안 되는 것

`.gitignore` 에 들어 있다. 확인하고 올릴 것.

- `admin_key.txt` — 관리자 비밀번호
- `memo.db` — 학생들이 쓴 글
