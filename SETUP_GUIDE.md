# 설정 가이드 - 태국어-한국어 다문화 학급 실시간 번역 채팅

이 문서는 `index.html` 하나로 구성된 프론트엔드를 실제로 동작시키기 위해 필요한
Firebase(Firestore + Authentication)와 Cloudflare Workers(OpenAI 번역 프록시) 설정을
처음부터 끝까지 안내합니다. 결제 수단 등록이나 유료 요금제 없이 전체 과정을 진행할 수 있습니다.

전체 구조를 한 줄로 요약하면: **Firebase는 로그인/실시간 채팅 저장소 역할만 하고,
OpenAI API 키는 Cloudflare Worker 안에만 존재**합니다. GitHub Pages에 올라가는
`index.html`에는 어떤 비밀 키도 들어가지 않습니다 (Firebase `firebaseConfig`는 공개되어도
안전한 값입니다 - 아래 "자주 묻는 질문" 참고).

---

## 0. 사전 준비: Node.js 설치

1. https://nodejs.org 에서 **LTS 버전**을 다운로드해 설치합니다.
2. 설치 후 터미널(명령 프롬프트/PowerShell)에서 확인:
   ```
   node -v
   npm -v
   ```
   버전 번호가 출력되면 정상입니다.

---

## 1. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 후 **프로젝트 추가**.
2. 프로젝트 이름 입력(예: `thai-classroom-chat`), Google 애널리틱스는 꺼도 무방합니다.
3. 요금제는 기본값인 **Spark(무료)** 그대로 둡니다. 이 프로젝트는 Cloud Functions를
   사용하지 않으므로 결제 수단 등록이 필요 없습니다.

### 1-1. Authentication 활성화
1. 왼쪽 메뉴 **Build > Authentication** > 시작하기.
2. **Sign-in method** 탭에서 다음 두 가지를 각각 클릭해 **사용 설정**:
   - **이메일/비밀번호** (교사 로그인용)
   - **익명** (학부모가 로그인 없이 채팅에 접속하기 위한 내부용 인증)

### 1-2. Firestore Database 활성화
1. 왼쪽 메뉴 **Build > Firestore Database** > 데이터베이스 만들기.
2. **프로덕션 모드**로 시작(규칙은 잠시 후 우리가 만든 파일로 덮어씁니다).
3. 위치는 `asia-northeast3`(서울) 또는 `asia-northeast1`(도쿄) 등 가까운 지역 선택.

### 1-3. 웹 앱 등록 및 firebaseConfig 복사
1. 프로젝트 개요 옆 톱니바퀴 > **프로젝트 설정** > 아래로 스크롤 > **웹 앱 추가**(</> 아이콘).
2. 앱 닉네임 입력 후 등록만 하면 됩니다(Firebase Hosting은 사용하지 않으므로 체크 안 해도 됨).
3. 표시되는 `firebaseConfig` 객체를 전체 복사합니다.
4. `index.html` 파일을 열어 아래 부분을 찾아 방금 복사한 값으로 통째로 교체합니다.
   ```js
   const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
     ...
   };
   ```

### 1-4. 교사 계정 만들기
1. **Authentication > Users** 탭 > **사용자 추가**.
2. 교사 이메일/비밀번호를 직접 입력해 계정을 만듭니다. (여러 명이면 반복)
3. 별도의 회원가입 화면은 없으며, 교사는 이 계정으로 로그인하면 처음 1회에 한해
   학부모 화면에 표시될 이름을 입력하는 팝업이 뜹니다.

---

## 2. Firebase CLI로 보안 규칙 배포

이 저장소에는 이미 `firestore.rules`, `firestore.indexes.json`, `firebase.json`,
`.firebaserc` 파일이 준비되어 있습니다.

1. Firebase CLI 설치:
   ```
   npm install -g firebase-tools
   ```
2. 로그인(브라우저 창이 열립니다):
   ```
   firebase login
   ```
3. `translate` 폴더로 이동한 뒤, `.firebaserc` 파일을 열어
   `"YOUR_FIREBASE_PROJECT_ID"` 부분을 1단계에서 만든 실제 Firebase 프로젝트 ID로 수정합니다.
   (프로젝트 ID는 Firebase 콘솔 프로젝트 설정 상단에서 확인 가능)
4. 규칙 배포:
   ```
   firebase deploy --only firestore:rules,firestore:indexes
   ```
5. Firebase 콘솔 > Firestore Database > 규칙 탭에서 방금 배포한 규칙이 반영됐는지 확인합니다.

---

## 3. Cloudflare Worker로 OpenAI 번역 프록시 배포

### 3-1. OpenAI API 키 발급
1. https://platform.openai.com 에 로그인 후 **API keys** 메뉴에서 새 키를 발급받습니다.
   (`gpt-4o` 모델 사용 권한이 있는 계정이어야 합니다)
2. **Settings > Billing > Usage limits**에서 월 한도(예: $10~20)를 미리 설정해두면
   예상치 못한 과금을 막을 수 있습니다.

### 3-2. Cloudflare 계정 및 Wrangler 설치
1. https://dash.cloudflare.com/sign-up 에서 무료 계정을 만듭니다(신용카드 불필요).
2. Wrangler(Cloudflare Workers CLI) 설치:
   ```
   npm install -g wrangler
   ```
3. 로그인:
   ```
   wrangler login
   ```

### 3-3. Worker 배포
1. 터미널에서 `translate/worker` 폴더로 이동합니다.
2. `wrangler.toml` 파일을 열어 `ALLOWED_ORIGIN` 값을 실제 GitHub Pages 주소로 수정합니다.
   (아직 GitHub Pages를 안 만들었다면 일단 예상 주소 `https://<GitHub아이디>.github.io`를
   넣어두고, 4단계에서 실제 주소를 확인한 뒤 다시 한번 확인/수정합니다.)
3. OpenAI 키를 시크릿으로 등록(코드/저장소에 남지 않고 Cloudflare에 암호화 저장됩니다):
   ```
   wrangler secret put OPENAI_API_KEY
   ```
   프롬프트가 뜨면 1단계에서 발급받은 키를 붙여넣습니다.
4. 배포:
   ```
   wrangler deploy
   ```
5. 배포가 끝나면 `https://classroom-translate-proxy.<계정서브도메인>.workers.dev` 형태의
   주소가 출력됩니다. 이 주소를 복사해 `index.html`의 다음 부분에 붙여넣습니다.
   ```js
   const WORKER_URL = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";
   ```

---

## 4. GitHub Pages 배포

1. GitHub에서 새 저장소를 만들고, `translate` 폴더 전체(적어도 `index.html`)를 push합니다.
2. 저장소 **Settings > Pages** 로 이동, **Source**를 `Deploy from a branch`로 설정,
   브랜치는 `main`, 폴더는 `/ (root)`로 지정 후 저장합니다.
3. 잠시 후 `https://<GitHub아이디>.github.io/<저장소이름>/` 형태의 주소가 활성화됩니다.
4. 이 실제 주소가 3-3에서 넣은 `ALLOWED_ORIGIN`과 다르다면:
   - `worker/wrangler.toml`의 `ALLOWED_ORIGIN`을 실제 주소로 수정
   - `wrangler deploy` 다시 실행

> **주의:** `ALLOWED_ORIGIN`은 프로토콜+도메인까지만 씁니다(예: `https://yourname.github.io`),
> 뒤에 저장소 경로(`/repo-name/`)는 붙이지 않습니다. 브라우저의 CORS 검사는 origin
> 단위(프로토콜+도메인+포트)로만 이루어지기 때문입니다.

---

## 5. 동작 테스트

1. 배포된 GitHub Pages 주소로 접속 → 1-4에서 만든 교사 계정으로 로그인.
2. 처음 로그인이면 학부모 화면에 표시될 이름을 입력하는 팝업이 뜹니다.
3. **+ 새 학생 등록** 버튼으로 태국 학생을 하나 등록합니다.
4. 학생 목록에서 **초대 링크** 버튼을 눌러 링크/QR코드를 확인합니다.
5. 그 링크를 복사해 **시크릿(비공개) 브라우저 창**으로 열어봅니다 → 학부모 화면(태국어 환영
   메시지 + 채팅창)이 뜨는지 확인합니다.
6. 교사 창에서 한국어로 메시지를 보내고, 학부모 창에 몇 초 안에 태국어 번역이 채워지는지 확인합니다.
7. 반대로 학부모 창에서 태국어로 메시지를 보내고 교사 창에 한국어 번역이 뜨는지 확인합니다.
8. 문제가 있다면:
   - 브라우저 개발자 도구 콘솔에서 에러 확인
   - `wrangler tail` 명령으로 Worker 쪽 실시간 로그 확인
   - Firebase 콘솔 > Firestore > 데이터 탭에서 메시지 문서가 실제로 생성/업데이트되는지 확인

---

## 자주 묻는 질문

**Q. GitHub Pages에 `firebaseConfig`가 그대로 노출되는데 괜찮은가요?**
A. 네, 정상입니다. `firebaseConfig`는 비밀 키가 아니라 "이 요청이 어느 프로젝트로 가야
하는지" 알려주는 공개 식별자입니다. 실제 보안은 `firestore.rules`(누가 무엇을
읽고 쓸 수 있는지)로 이루어지며, 이 프로젝트에서는 그 규칙을 최대한 엄격하게
작성해두었습니다. 반면 OpenAI API 키는 실제 비밀이므로 Cloudflare Worker 안에만
두고 어떤 프론트엔드 코드에도 넣지 않았습니다.

**Q. 학부모 초대 링크가 유출되면 어떻게 되나요?**
A. 이 링크는 로그인을 대신하는 "접속 토큰" 역할을 하므로, 링크를 아는 사람은 누구나
해당 학생의 대화방에 접속할 수 있습니다. 현재 버전에는 링크 재발급(폐기) 기능이
없으므로, 유출이 우려되면 해당 학생을 새로 등록해 새 링크를 발급하고 기존 학생
항목은 더 이상 사용하지 않는 방식으로 운영해주세요.

**Q. 비용이 걱정됩니다.**
A. Firebase Firestore/Authentication은 소규모 학급 사용량에서는 무료 한도 내에서
충분히 운영 가능합니다. Cloudflare Workers 무료 티어는 하루 10만 요청까지 무료입니다.
실질적인 비용은 OpenAI API 호출(메시지 1건당 1회)뿐이며, 위 3-1단계에서 설정한
사용량 한도로 예상치 못한 과금을 방지할 수 있습니다.

**Q. 교사를 더 추가하려면?**
A. Firebase 콘솔 Authentication에서 이메일/비밀번호 계정을 추가로 만들면 됩니다.
각 교사는 로그인 즉시 자신만의 학생 목록/채팅을 관리하며, Firestore 규칙상 다른
교사의 데이터에는 접근할 수 없습니다.
