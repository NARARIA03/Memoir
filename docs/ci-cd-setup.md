# Memoir CI/CD 설정 가이드

> GitHub Actions를 활용한 CI/CD 파이프라인 구축

## 목차

1. [개요](#개요)
2. [아키텍처](#아키텍처)
3. [CI: PR 검증 워크플로우](#ci-pr-검증-워크플로우)
4. [CD: 배포 워크플로우](#cd-배포-워크플로우)
5. [Docker 설정](#docker-설정)
6. [Prisma 초기 세팅](#prisma-초기-세팅)
7. [GitHub Secrets 설정](#github-secrets-설정)
8. [구현할 파일 목록](#구현할-파일-목록)
9. [작업 순서](#작업-순서)

---

## 개요

### 목표

- **PR 검증**: 코드 품질 자동 검증 (TypeScript, ESLint, Prettier)
- **자동 배포**: main 브랜치 병합 시 홈 서버에 자동 배포
- **DB 안정성**: PostgreSQL 다운타임 없이 Next.js만 재배포

### 핵심 결정 사항

| 항목                | 결정                             |
| ------------------- | -------------------------------- |
| 서버 접근 방식      | SSH 키 인증                      |
| 이미지 레지스트리   | GHCR (GitHub Container Registry) |
| 태그 전략           | `latest` 만 사용                 |
| docker-compose 위치 | 레포에서 관리                    |
| DB 운영             | 같은 Compose에서 관리            |

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Actions                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐         ┌──────────────────────────────┐  │
│  │   CI Workflow    │         │        CD Workflow           │  │
│  │                  │         │                              │  │
│  │  PR 열림 시 실행  │         │     main 병합 시 실행         │  │
│  │                  │         │                              │  │
│  │  - type-check    │         │  1. Docker 이미지 빌드        │  │
│  │  - lint          │         │  2. GHCR에 push              │  │
│  │  - format:check  │         │  3. SSH로 홈서버 접속         │  │
│  │                  │         │  4. docker pull              │  │
│  └──────────────────┘         │  5. docker compose up -d     │  │
│                               │  6. prisma migrate deploy    │  │
│                               └──────────────────────────────┘  │
│                                           │                      │
└───────────────────────────────────────────┼──────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         홈 서버                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   Docker Compose                         │    │
│  │  ┌─────────────────┐      ┌─────────────────────────┐   │    │
│  │  │      app        │      │           db            │   │    │
│  │  │   (Next.js)     │─────▶│  (PostgreSQL+pgvector)  │   │    │
│  │  │                 │      │                         │   │    │
│  │  │  ghcr.io/...    │      │  pgvector/pgvector:pg17 │   │    │
│  │  │  :latest        │      │                         │   │    │
│  │  └─────────────────┘      └─────────────────────────┘   │    │
│  │          │                            │                  │    │
│  │          │                            │                  │    │
│  │          ▼                            ▼                  │    │
│  │     Port 13000                  postgres_data            │    │
│  │                                   (Volume)               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────┐                                            │
│  │   cloudflared   │ ◀─── Cloudflare Tunnel                     │
│  └─────────────────┘                                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## CI: PR 검증 워크플로우

### 트리거 조건

- PR이 main 브랜치로 열릴 때

### 검증 항목

| 검증 항목  | 명령어                 | 설명               |
| ---------- | ---------------------- | ------------------ |
| TypeScript | `npm run type-check`   | 타입 오류 검사     |
| ESLint     | `npm run lint`         | 린트 규칙 검사     |
| Prettier   | `npm run format:check` | 포맷팅 일관성 검사 |

> **참고**: 모든 검증 명령어를 npm script로 통일하여 로컬/CI 환경에서 일관성을 유지합니다.
> package.json에 다음 스크립트를 추가해야 합니다:
>
> ```json
> {
>   "scripts": {
>     "type-check": "tsc --noEmit",
>     "format:check": "prettier --check .",
>     "format": "prettier --write ."
>   }
> }
> ```

### 워크플로우 파일

**`.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  validate:
    name: Validate Code Quality
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run type-check

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check
```

---

## CD: 배포 워크플로우

### 트리거 조건

- main 브랜치에 push (PR 병합 포함)

### 배포 단계

```
1. Docker 이미지 빌드
   └─▶ Next.js standalone 모드로 최적화된 이미지 생성

2. GHCR에 push
   └─▶ ghcr.io/nararia03/memoir:latest

3. SSH로 홈서버 접속
   └─▶ appleboy/ssh-action 사용

4. 최신 이미지 pull
   └─▶ docker compose pull app

5. Next.js 컨테이너 재시작
   └─▶ docker compose up -d app
   └─▶ DB는 재시작하지 않음 (다운타임 없음)

6. Prisma Migration 실행
   └─▶ docker compose exec -T app npx prisma migrate deploy

7. 이전 이미지 정리
   └─▶ docker image prune -f (dangling 이미지 삭제로 디스크 공간 확보)
```

> **Prisma Migration 시점 참고**: 현재 순서는 앱 시작 후 마이그레이션을 실행합니다. 마이그레이션이
> 완료되기 전에 앱이 요청을 받을 수 있으나, 스키마 변경이 자주 없다면 큰 문제가 되지 않습니다. 더
> 안전한 방법이 필요하다면 `docker compose run --rm app npx prisma migrate deploy`를 `up -d app`
> 이전에 실행하거나, entrypoint 스크립트에서 마이그레이션을 처리하세요.

### 워크플로우 파일

**`.github/workflows/cd.yml`**

```yaml
name: CD

on:
  push:
    branches: [main]

# 워크플로우 레벨 환경변수
env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }} # github.repository는 GitHub에서 자동 제공 (예: NARARIA03/Memoir)

jobs:
  build-and-push:
    name: Build and Push Docker Image
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }} # GitHub에서 자동 제공 (워크플로우 트리거한 사용자)
          password: ${{ secrets.GITHUB_TOKEN }} # GitHub에서 자동 제공 (permissions에서 packages: write 필요)

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          # tags: 이미지를 어떤 이름으로 저장할지 지정 (필수)
          # :latest는 버전 태그. 명시하지 않으면 기본값이지만 명시적으로 지정하는 게 좋음
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest

  deploy:
    name: Deploy to Home Server
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USERNAME }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SSH_PORT }}
          script: |
            cd ~/Memoir

            # 1. 최신 이미지 pull (docker-compose.yml에 nextjs 컨테이너 이름이 app으로 명시되어 있어서, pull app 하면 알아서 docker-compose.yml의 image 필드 참조)
            docker compose pull app

            # 2. app 컨테이너만 재시작 (DB는 유지)
            docker compose up -d app

            # 3. 마이그레이션 실행
            # -T: pseudo-TTY 비활성화. GitHub Actions는 실제 터미널이 없어서
            #     -T 없이 실행하면 "the input device is not a TTY" 에러 발생
            docker compose exec -T app npx prisma migrate deploy

            # 4. 이전 이미지 정리 (dangling 이미지 삭제)
            docker image prune -f
```

---

## Docker 설정

### Dockerfile

Next.js 공식 standalone 빌드 패턴을 사용합니다.

> **참고 문서**:
>
> - [Next.js with Docker 예시](https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile)
> - [Prisma 배포 가이드](https://www.prisma.io/docs/orm/prisma-client/deployment)

```dockerfile
# ===== Builder =====
# CI/CD 환경에서는 Docker 레이어 캐시 이점이 거의 없으므로 deps와 builder를 통합
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Prisma 클라이언트 생성
RUN npx prisma generate

# Next.js 빌드 (standalone 모드)
RUN npm run build

# ===== Runner =====
FROM node:24-alpine AS runner
WORKDIR /app

# 환경변수 설정 (한 곳에서 관리)
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 정적 파일
COPY --from=builder /app/public ./public

# standalone 빌드 결과물
# builder의 WORKDIR가 /app 이므로, 여기서 가져올 때는 /app/.next 형태로 가져와야 함
# 마찬가지로 runnder의 WORKDIR도 /app 이므로, COPY --from=builder /app/.next/standalone ./ 는 runner의 /app 안에 standalone 디렉토리 내 파일을 복사하는 것
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Prisma 관련 파일 (런타임에 필요)
# 커스텀 output 경로(src/generated/prisma)를 사용하므로 해당 경로를 복사
COPY --from=builder /app/src/generated/prisma ./src/generated/prisma
COPY --from=builder /app/node_modules/@prisma/adapter-pg ./node_modules/@prisma/adapter-pg
COPY --from=builder /app/node_modules/pg ./node_modules/pg
COPY --from=builder /app/prisma ./prisma

# 보안을 위한 non-root 사용자
# node:alpine 이미지에는 기본 'node' 사용자(uid 1000)가 포함되어 있음
USER node

CMD ["node", "server.js"]
```

### docker-compose.yml

> **용어 정리**:
>
> - **서비스(service)**: docker-compose.yml에서 정의하는 `app`, `db` 등
> - **컨테이너(container)**: 서비스가 실행되면 생성되는 실제 인스턴스

```yaml
services:
  app:
    image: ghcr.io/nararia03/memoir:latest
    container_name: memoir-app
    ports:
      - '13000:3000' # 외부 13000 → 내부 3000
    environment:
      - DATABASE_URL=postgresql://memoir:${DB_PASSWORD}@db:5432/memoir
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - memoir-network

  db:
    image: pgvector/pgvector:pg17
    container_name: memoir-db
    # ports 미지정 → 내부 네트워크에서만 접근 가능 (호스트의 다른 PostgreSQL과 충돌 없음)
    environment:
      - POSTGRES_USER=memoir
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=memoir
    volumes:
      - postgres_data:/var/lib/postgresql/data
    # healthcheck: Docker가 db 컨테이너 내부에서 명령어를 실행하여 상태 확인
    # - test: pg_isready는 PostgreSQL 클라이언트 도구로, DB가 연결을 받을 준비가 됐는지 확인
    #         종료 코드 0 = healthy, 그 외 = unhealthy
    # - app 서비스의 depends_on.condition: service_healthy가 이 상태를 감시
    #   → db가 healthy가 될 때까지 app 컨테이너 시작을 대기
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U memoir']
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - memoir-network

volumes:
  postgres_data:

networks:
  memoir-network:
    driver: bridge
```

> **포트 설정 참고**:
>
> - `app`: 외부 13000 포트 → 컨테이너 내부 3000 포트
> - `db`: 외부 노출 없음 (내부 네트워크에서만 app이 접근)

> **docker compose pull app 동작 원리**:
>
> `docker compose pull app` 실행 시 docker-compose.yml에서 `app` 서비스의 `image` 필드
> (`ghcr.io/nararia03/memoir:latest`)를 읽어 해당 이미지를 레지스트리에서 pull합니다. 별도로
> 이미지를 명시할 필요가 없습니다.

### .dockerignore

> **Q: .env를 제외해도 되나요?**
>
> 네, **제외해야 합니다**. 이유:
>
> 1. Docker 이미지 **빌드 시**에는 환경변수가 필요 없음 (`npm run build`는 `DATABASE_URL` 없이 가능)
> 2. 환경변수는 **런타임**에 `docker-compose.yml`의 `environment`로 주입됨
> 3. **보안**: 이미지에 `.env`가 포함되면 레지스트리에 민감 정보가 노출될 수 있음

```
# Dependencies
node_modules

# Next.js build output
.next

# Git
.git
.github

# Documentation
*.md
docs/

# Environment (보안상 제외 - 런타임에 docker-compose로 주입)
.env*

# Development tools
.husky
.vscode
```

### next.config.ts 수정

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  output: 'standalone', // Docker 배포를 위한 standalone 모드
};

export default nextConfig;
```

---

## Prisma 초기 세팅

CD 빌드가 성공하려면 Prisma가 설치되어 있어야 합니다. Prisma 5.x 최신 방식(어댑터 패턴)을
사용합니다.

> **참고 문서**: [Prisma + Next.js 공식 가이드](https://www.prisma.io/docs/guides/frameworks/nextjs)

### 1. 패키지 설치

```bash
# devDependencies
npm install prisma --save-dev

# dependencies (어댑터 패턴)
npm install @prisma/client @prisma/adapter-pg pg
```

### 2. package.json에 postinstall 추가

배포 시 `npm ci` 후 자동으로 Prisma 클라이언트가 생성되도록 합니다.

```json
{
  "scripts": {
    "postinstall": "prisma generate"
  }
}
```

### 3. Prisma 초기화

```bash
npx prisma init
```

이 명령어는 다음 파일들을 생성합니다:

- `prisma/schema.prisma`: 데이터베이스 스키마 정의
- `.env`: DATABASE_URL 환경변수 (gitignore에 포함되어야 함)

### 4. schema.prisma 작성

초기 세팅에서는 pgvector 확장만 설정합니다. 모델은 이후 기능 개발 시 추가합니다.

```prisma
// prisma/schema.prisma

generator client {
  provider        = "prisma-client-js"
  output          = "../src/generated/prisma"
  previewFeatures = ["postgresqlExtensions", "driverAdapters"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}

// 모델은 기능 개발 시 추가
```

> **output 경로 설명**: 클라이언트를 `src/generated/prisma`에 생성합니다. node_modules 외부에
> 생성되어 타입 추론이 명확합니다.
>
> `.gitignore`에 다음을 추가하세요 (prisma generate로 생성되므로):
>
> ```
> src/generated/
> ```

### 5. 로컬 개발용 .env

```bash
# .env (로컬 개발용 - gitignore에 포함)
DATABASE_URL="postgresql://memoir:localpassword@localhost:5432/memoir"
```

### 6. Prisma 클라이언트 생성

```bash
npx prisma generate
```

### 7. lib/prisma.ts 싱글톤 생성 (어댑터 패턴)

Prisma 5.x에서는 어댑터 패턴을 사용합니다.

```typescript
// src/lib/prisma.ts
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

> **import 경로**: `@/generated/prisma`는 tsconfig.json의 paths 설정에 따라 `src/generated/prisma`를
> 가리킵니다.

### 8. 로컬 DB로 마이그레이션 테스트

```bash
# 로컬에서 PostgreSQL + pgvector 실행 (docker-compose.yml 사용)
docker compose up -d db

# 마이그레이션 생성 및 적용
npx prisma migrate dev --name init

# Prisma Studio로 확인 (선택)
npx prisma studio
```

> **참고**: 로컬 개발 시에는 `migrate dev`, 프로덕션(CD)에서는 `migrate deploy`를 사용합니다.
>
> - `migrate dev`: 개발용, 스키마 변경 감지 및 마이그레이션 파일 생성
> - `migrate deploy`: 프로덕션용, 기존 마이그레이션 파일만 적용

---

## GitHub Secrets 설정

GitHub 레포지토리 > Settings > Secrets and variables > Actions에서 설정합니다.

### 필요한 Secrets

| Secret 이름       | 설명                      |
| ----------------- | ------------------------- |
| `SSH_HOST`        | 홈 서버 IP                |
| `SSH_USERNAME`    | SSH 접속 사용자명         |
| `SSH_PRIVATE_KEY` | SSH private key 전체 내용 |
| `SSH_PORT`        | SSH 포트 (기본값: 22)     |

### SSH 키 가져오기

```bash
# 개발 환경에서 private key 내용 확인 후 GitHub Secrets에 등록
cat server-key.pem
```

### 홈 서버 준비 사항

```bash
# 레포지토리 클론
git clone https://github.com/NARARIA03/Memoir.git

# 레포지토리로 이동
cd Memoir

# .env 생성
cat > .env << EOF
DB_PASSWORD=your_secure_password
EOF
```

### 초기 배포 순서

```bash
# 1. 홈 서버에 docker-compose.yml, .env 준비 (위 단계 완료)

# 2. DB 먼저 시작
docker compose up -d db

# 3. main 브랜치에 코드 병합
#    → CD가 자동으로 이미지 빌드 → GHCR push → app 배포 → prisma migrate 실행

# 이후 배포는 PR 병합 시 CD가 자동 처리
```

### 환경변수 목록

`.env` 파일에 설정합니다.

| 변수명        | 설명                | 예시                   |
| ------------- | ------------------- | ---------------------- |
| `DB_PASSWORD` | PostgreSQL 비밀번호 | `your_secure_password` |

```bash
# .env 파일 예시
DB_PASSWORD=your_secure_password
```

> **참고**: `DATABASE_URL`은 docker-compose.yml에서 자동 생성됩니다.
> `postgresql://memoir:${DB_PASSWORD}@db:5432/memoir`

---

## 구현할 파일 목록

| 파일 경로                  | 작업 | 설명                                                           |
| -------------------------- | ---- | -------------------------------------------------------------- |
| `package.json`             | 수정 | `type-check`, `format:check`, `format`, `postinstall` 스크립트 |
| `next.config.ts`           | 수정 | `output: 'standalone'` 추가                                    |
| `.gitignore`               | 수정 | `src/generated/` 추가                                          |
| `prisma/schema.prisma`     | 생성 | Prisma 스키마 (output + pgvector + driverAdapters)             |
| `src/lib/prisma.ts`        | 생성 | Prisma 클라이언트 싱글톤 (어댑터 패턴)                         |
| `.dockerignore`            | 생성 | Docker 빌드 제외 파일                                          |
| `Dockerfile`               | 생성 | Next.js standalone 빌드                                        |
| `docker-compose.yml`       | 생성 | Next.js + PostgreSQL + pgvector                                |
| `.github/workflows/ci.yml` | 생성 | PR 검증 워크플로우                                             |
| `.github/workflows/cd.yml` | 생성 | 배포 워크플로우                                                |

---

## 작업 순서

### 1단계: 프로젝트 설정

```bash
# 1. package.json 스크립트 추가
#    - type-check, format:check, format
#    - postinstall: "prisma generate"

# 2. next.config.ts에 output: 'standalone' 추가

# 3. Prisma 설치 (어댑터 패턴)
npm install prisma --save-dev
npm install @prisma/client @prisma/adapter-pg pg

# 4. Prisma 초기화
npx prisma init

# 5. prisma/schema.prisma 작성 (driverAdapters 프리뷰 추가)

# 6. src/lib/prisma.ts 싱글톤 생성 (어댑터 패턴)
```

### 2단계: Docker 파일 생성

```bash
# 1. .dockerignore 생성
# 2. Dockerfile 생성
# 3. docker-compose.yml 생성
```

### 3단계: 로컬 Docker 테스트

```bash
# DB 시작 후 마이그레이션
docker compose up -d db
npx prisma migrate dev --name init

# 이미지 빌드 테스트
docker build -t memoir:test .

# Compose 테스트 (로컬용 .env 필요)
docker compose up -d

# 로그 확인
docker compose logs -f app

# 정리
docker compose down
```

### 4단계: GitHub Actions 설정

```bash
# 1. .github/workflows/ci.yml 생성
# 2. .github/workflows/cd.yml 생성
# 3. GitHub Secrets 설정
```

### 5단계: 홈 서버 준비

```bash
# 1. ~ 에 레포지토리 클론
# 2. .env 파일 생성
# 3. DB 시작 (docker compose up -d db)
```

### 6단계: 검증

```bash
# 1. PR 생성하여 CI 워크플로우 확인
# 2. PR 병합하여 CD 워크플로우 확인
# 3. 홈 서버에서 서비스 동작 확인
```

---

## 트러블슈팅

### CI 실패 시

```bash
# 로컬에서 동일한 검증 실행
npm run type-check
npm run lint
npm run format:check

# 포맷팅 자동 수정
npm run format
```

### CD 실패 시: SSH 연결 문제

```bash
# 로컬에서 SSH 연결 테스트
ssh -i ~/.ssh/id_ed25519 user@host -p port

# SSH 키 권한 확인
chmod 600 ~/.ssh/id_ed25519
```

### CD 실패 시: Docker 관련

```bash
# 홈 서버에서 수동으로 실행
cd ~/Memoir
docker compose pull app
docker compose up -d app
docker compose logs -f app
```

### Prisma Migration 실패 시

```bash
# 마이그레이션 상태 확인
docker compose exec app npx prisma migrate status

# 수동 마이그레이션
docker compose exec app npx prisma migrate deploy
```
