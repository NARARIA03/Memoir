# Memoir CI/CD 설정 가이드

> GitHub Actions를 활용한 CI/CD 파이프라인 구축

## 목차

1. [개요](#개요)
2. [아키텍처](#아키텍처)
3. [CI: PR 검증 워크플로우](#ci-pr-검증-워크플로우)
4. [CD: 배포 워크플로우](#cd-배포-워크플로우)
5. [Docker 설정](#docker-설정)
6. [GitHub Secrets 설정](#github-secrets-설정)
7. [구현할 파일 목록](#구현할-파일-목록)
8. [작업 순서](#작업-순서)

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

| 검증 항목  | 명령어                   | 설명               |
| ---------- | ------------------------ | ------------------ |
| TypeScript | `npx tsc --noEmit`       | 타입 오류 검사     |
| ESLint     | `npm run lint`           | 린트 규칙 검사     |
| Prettier   | `npx prettier --check .` | 포맷팅 일관성 검사 |

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
        run: npx tsc --noEmit

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npx prettier --check .
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
```

### 워크플로우 파일

**`.github/workflows/cd.yml`**

```yaml
name: CD

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

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
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}

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
            docker compose pull app
            docker compose up -d app
            docker compose exec -T app npx prisma migrate deploy
            docker image prune -f
```

---

## Docker 설정

### Dockerfile

Next.js 공식 standalone 빌드 패턴을 사용합니다.

```dockerfile
# ===== Base =====
FROM node:24-alpine AS base

# ===== Dependencies =====
FROM base AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

# ===== Builder =====
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma 클라이언트 생성
RUN npx prisma generate

# Next.js 빌드
RUN npm run build

# ===== Runner =====
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# 보안을 위한 non-root 사용자
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 정적 파일
COPY --from=builder /app/public ./public

# standalone 빌드 결과물
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Prisma 관련 파일
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

### docker-compose.yml

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

### .dockerignore

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

# Environment
.env*

# Development tools
.husky
.vscode
.idea

# Test
coverage/
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

| 파일 경로                  | 작업 | 설명                            |
| -------------------------- | ---- | ------------------------------- |
| `next.config.ts`           | 수정 | `output: 'standalone'` 추가     |
| `.dockerignore`            | 생성 | Docker 빌드 제외 파일           |
| `Dockerfile`               | 생성 | Next.js standalone 빌드         |
| `docker-compose.yml`       | 생성 | Next.js + PostgreSQL + pgvector |
| `.github/workflows/ci.yml` | 생성 | PR 검증 워크플로우              |
| `.github/workflows/cd.yml` | 생성 | 배포 워크플로우                 |

---

## 작업 순서

### 1단계: 로컬 환경 설정

```bash
# 1. next.config.ts standalone 설정
# 2. .dockerignore 생성
# 3. Dockerfile 생성
# 4. docker-compose.yml 생성
```

### 2단계: 로컬 Docker 테스트

```bash
# 이미지 빌드 테스트
docker build -t memoir:test .

# Compose 테스트 (로컬용 .env 필요)
docker compose up -d

# 로그 확인
docker compose logs -f app

# 정리
docker compose down
```

### 3단계: GitHub Actions 설정

```bash
# 1. .github/workflows/ci.yml 생성
# 2. .github/workflows/cd.yml 생성
# 3. GitHub Secrets 설정
```

### 4단계: 홈 서버 준비

```bash
# 1. ~ 에 레포지토리 클론
# 2. .env 파일 생성
# 3. DB 시작 (docker compose up -d db)
```

### 5단계: 검증

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
npx tsc --noEmit
npm run lint
npx prettier --check .

# 포맷팅 자동 수정
npx prettier --write .
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
