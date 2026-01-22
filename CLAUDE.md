# Memoir

> LLM 기반 커리어 세컨드 브레인: 파편화된 경험을 강력한 커리어 자산으로.

## 프로젝트 개요

Memoir는 파편화된 업무 기록(Notion, GitHub Issue 등)을 AI를 통해 **구조화/정제/벡터화**하여,
자신만의 커리어 코치를 구축하는 RAG 서비스입니다.

### 핵심 가치

- **기록의 최소화**: 복붙만 하면 LLM이 구조화
- **자산화**: 언제든 RAG로 과거 경험 검색 가능
- **민감정보 보호**: LLM이 회사 기밀 정보를 자동 탐지, 사용자가 검토 후 제거

## 기술 스택

| 영역       | 기술                                                         |
| ---------- | ------------------------------------------------------------ |
| Frontend   | Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui |
| Backend    | Next.js Route Handlers                                       |
| Database   | PostgreSQL + pgvector                                        |
| ORM        | Prisma                                                       |
| Data Fetch | TanStack Query v5 (React Query)                              |
| Validation | Zod                                                          |
| LLM        | Claude Sonnet 4 / GPT-5 (미정, 교체 가능하게 설계)           |
| Embedding  | OpenAI text-embedding-3-small                                |
| Infra      | Docker Compose, Cloudflare Tunnel, GitHub Actions CI/CD      |
| Language   | TypeScript 5 (strict mode)                                   |

### 주요 라이브러리

- **TanStack Query v5**: 서버 상태 관리, prefetch 기반 SSR
- **Prisma**: 타입 안전한 DB 접근, pgvector 지원
- **Zod**: 런타임 스키마 검증 + LLM 응답 파싱
- **shadcn/ui**: 빠른 UI 구축

## 아키텍처

### 배포 구조

```
User → Cloudflare Network → cloudflared (Tunnel) → Docker Compose
                                                      ├── Next.js (Frontend + API)
                                                      └── PostgreSQL + pgvector
```

- 홈서버에서 Docker Compose로 운영
- Cloudflare Tunnel로 외부 노출 없이 보안 접속
- GitHub Actions로 CI/CD

### 데이터 플로우

```
[페이지 1: Input]
원본 텍스트 붙여넣기
    ↓ useMutation → POST /api/records/process
    ↓ LLM 호출 (구조화 + 민감정보 추출)
    ↓ Draft 상태로 DB 저장
    ↓ router.push → /review/[id]

[페이지 2: Review]
폼에서 검토/수정 (민감정보 하이라이트)
    ↓ useMutation → POST /api/records/confirm
    ↓ Embedding 생성
    ↓ pgvector + RDB 저장 (Confirmed 상태)
    ↓ invalidateQueries → /records

[페이지 3: Chat]
RAG 채팅 (stateless, 매번 새 대화)
    ↓ POST /api/chat (streaming)
    ↓ Query embedding → pgvector 유사도 검색 → LLM 응답

[페이지 4: Records]
업무 기록 테이블 뷰 (노션 스타일)
    ↓ prefetchQuery + useQuery
```

### 데이터 Fetching 전략 (React Query v5 + Prefetch)

서버 컴포넌트에서 prefetch하고, 클라이언트 컴포넌트에서 useQuery로 hydrate하는 패턴.

| 작업      | 방식                            |
| --------- | ------------------------------- |
| 조회      | prefetchQuery (SSR) + useQuery  |
| 생성/수정 | useMutation + invalidateQueries |
| 삭제      | useMutation + invalidateQueries |
| 스트리밍  | Route Handler (채팅 등)         |

#### Prefetch 패턴 예시

```typescript
// app/records/page.tsx (서버 컴포넌트)
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { getRecords } from '@/features/record/apis';
import RecordsContainer from '@/features/record/containers/RecordsContainer';

const RecordsPage = async () => {
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    queryKey: ['records'],
    queryFn: getRecords,
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <RecordsContainer />
    </HydrationBoundary>
  );
};

export default RecordsPage;
```

```typescript
// features/record/containers/RecordsContainer.tsx
'use client';

import { useRecords } from '../hooks/queries/useRecords';

const RecordsContainer = () => {
  const { data: records } = useRecords();

  return <RecordTable records={records} />;
};

export default RecordsContainer;
```

```typescript
// features/record/hooks/queries/useRecords.ts
import { useQuery } from '@tanstack/react-query';
import { getRecords } from '../../apis';

export const useRecords = () => {
  return useQuery({
    queryKey: ['records'],
    queryFn: getRecords,
  });
};
```

#### Mutation 패턴 예시

```typescript
// features/record/hooks/mutations/useConfirmRecord.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { confirmRecord } from '../../apis';

export const useConfirmRecord = () => {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: confirmRecord,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['records'] });
      router.push('/records');
    },
  });
};
```

## 폴더 구조

```
src/
├── app/                          # Next.js App Router (라우팅 전용, thin layer)
│   ├── input/
│   │   └── page.tsx              # → <InputContainer />
│   ├── review/
│   │   └── [id]/
│   │       └── page.tsx          # → <ReviewContainer />
│   ├── chat/
│   │   └── page.tsx              # → <ChatContainer />
│   ├── records/
│   │   └── page.tsx              # → prefetch + <RecordsContainer />
│   ├── api/                      # Route Handlers
│   │   ├── records/
│   │   │   ├── route.ts          # GET (목록), POST (생성)
│   │   │   ├── [id]/
│   │   │   │   └── route.ts      # GET, PATCH, DELETE
│   │   │   ├── process/
│   │   │   │   └── route.ts      # POST: 원본 → LLM 구조화
│   │   │   └── confirm/
│   │   │       └── route.ts      # POST: 최종 저장 + 벡터화
│   │   └── chat/
│   │       └── route.ts          # POST: RAG 채팅 (streaming)
│   ├── layout.tsx
│   ├── page.tsx                  # 랜딩 또는 /input 리다이렉트
│   ├── providers.tsx             # QueryClientProvider 등
│   └── globals.css
│
├── features/                     # 도메인별 로직 (FSD 스타일)
│   ├── record/                   # 업무 기록 도메인
│   │   ├── apis/                 # API 호출 함수
│   │   │   ├── getRecords.ts
│   │   │   ├── getRecord.ts
│   │   │   ├── processRecord.ts
│   │   │   ├── confirmRecord.ts
│   │   │   └── index.ts
│   │   ├── components/           # UI 컴포넌트
│   │   ├── containers/           # 페이지 컨테이너
│   │   ├── hooks/
│   │   │   ├── queries/          # useQuery 훅
│   │   │   │   ├── useRecords.ts
│   │   │   │   └── useRecord.ts
│   │   │   └── mutations/        # useMutation 훅
│   │   │       ├── useProcessRecord.ts
│   │   │       └── useConfirmRecord.ts
│   │   ├── services/             # 비즈니스 로직 (서버 사이드)
│   │   │   └── structureRecord.ts
│   │   ├── prompts/              # LLM 프롬프트 템플릿
│   │   ├── schemas/              # Zod 스키마
│   │   ├── types/
│   │   └── utils/
│   └── chat/                     # RAG 채팅 도메인
│       ├── apis/
│       ├── components/
│       ├── containers/
│       ├── hooks/
│       ├── prompts/
│       └── services/
│
├── components/                   # 전역 공용 컴포넌트
│   └── ui/                       # shadcn/ui 컴포넌트
│
├── lib/                          # 인프라 레벨 유틸리티
│   ├── prisma.ts                 # Prisma 클라이언트 싱글톤
│   ├── llm.ts                    # LLM API 호출 추상화 (Claude/GPT 스위칭)
│   ├── embedding.ts              # OpenAI Embedding 클라이언트
│   ├── queryClient.ts            # QueryClient 팩토리
│   └── utils.ts                  # cn() 등 유틸
│
├── types/                        # 전역 타입 정의
│   └── index.ts
│
└── constants/                    # 전역 상수
    └── index.ts
```

### 폴더 구조 원칙

- **app/**: 라우팅만 담당, 비즈니스 로직 없음. page.tsx는 prefetch + container 렌더링
- **features/**: 도메인별 로직 캡슐화. feature 간 참조 금지
- **components/**: 순수 UI 컴포넌트, 비즈니스 로직 없음
- **lib/**: DB, 외부 API 등 인프라 레벨 코드. 모든 feature에서 참조 가능

### 의존성 방향

```
app → features → lib
        ↓
    components
```

- features는 lib을 참조할 수 있음
- features끼리는 서로 참조하지 않음
- 공통 로직은 lib으로 추출

## React Query 설정

### QueryClient Provider

```typescript
// app/providers.tsx
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useState } from 'react';

type Props = {
  children: React.ReactNode;
};

const Providers = ({ children }: Props) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1분
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
};

export default Providers;
```

```typescript
// app/layout.tsx
import Providers from './providers';

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="ko">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
};

export default RootLayout;
```

### Prefetch용 QueryClient 팩토리

```typescript
// lib/queryClient.ts
import { QueryClient } from '@tanstack/react-query';

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
      },
    },
  });
```

## 데이터 모델

### Prisma 개요

Prisma는 Node.js/TypeScript용 ORM으로, 다음 구성요소로 이루어짐:

- **Prisma Schema** (`prisma/schema.prisma`): 데이터 모델 정의
- **Prisma Client**: 타입 안전한 쿼리 빌더 (자동 생성)
- **Prisma Migrate**: 스키마 변경 → DB 마이그레이션
- **Prisma Studio**: DB GUI 도구

### Prisma Schema

```prisma
// prisma/schema.prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}

model WorkRecord {
  id        String   @id @default(cuid())
  status    Status   @default(DRAFT)

  // 메타데이터
  company     String
  project     String
  startAt     DateTime
  endAt       DateTime?
  techStack   String[]
  tags        String[]

  // 구조화된 콘텐츠
  summary     String    // 한 줄 요약 (이력서용)
  problem     String    // 문제 상황 + 해결 과정
  decision    String    // 의사결정 근거
  reflection  String    // 배운점 / 아쉬운점

  // 원본 및 벡터
  rawContent  String    // 원본 텍스트 (복붙한 그대로)
  embedding   Unsupported("vector(1536)")?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

enum Status {
  DRAFT      // LLM 구조화 완료, 사용자 검토 전
  CONFIRMED  // 사용자 검토 완료, 벡터화 저장됨
}
```

### Prisma 클라이언트 설정

```typescript
// lib/prisma.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query'] : [],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

개발 환경에서 Hot Reload 시 여러 Prisma 인스턴스가 생성되는 것을 방지하기 위해 globalThis에
싱글톤으로 저장한다.

### Prisma 사용 예시

```typescript
// 조회
const records = await prisma.workRecord.findMany({
  where: { status: 'CONFIRMED' },
  orderBy: { createdAt: 'desc' },
});

// 단건 조회
const record = await prisma.workRecord.findUnique({
  where: { id },
});

// 생성
const newRecord = await prisma.workRecord.create({
  data: {
    company: 'Acme Corp',
    project: 'Dashboard',
    // ...
  },
});

// 수정
const updated = await prisma.workRecord.update({
  where: { id },
  data: { status: 'CONFIRMED' },
});

// 삭제
await prisma.workRecord.delete({
  where: { id },
});
```

### pgvector 유사도 검색

```typescript
// lib/embedding.ts
import { prisma } from './prisma';

export const searchSimilarRecords = async (queryEmbedding: number[], limit = 5) => {
  const results = await prisma.$queryRaw`
    SELECT id, company, project, summary, problem, decision, reflection,
           embedding <=> ${queryEmbedding}::vector AS distance
    FROM "WorkRecord"
    WHERE status = 'CONFIRMED'
    ORDER BY distance
    LIMIT ${limit}
  `;

  return results;
};
```

### LLM 응답 스키마 (구조화 + 민감정보)

```typescript
// features/record/schemas/structuredRecord.ts
import { z } from 'zod';

export const structuredRecordSchema = z.object({
  structured: z.object({
    company: z.string(),
    project: z.string(),
    startAt: z.string(), // ISO date string
    endAt: z.string().nullable(),
    techStack: z.array(z.string()),
    tags: z.array(z.string()),
    summary: z.string(),
    problem: z.string(),
    decision: z.string(),
    reflection: z.string(),
  }),
  sensitiveTerms: z.array(z.string()), // 민감정보 문자열 배열
});

export type StructuredRecord = z.infer<typeof structuredRecordSchema>;
```

## API 설계

### GET /api/records

업무 기록 목록 조회

```typescript
// Response
{
  records: WorkRecord[]
}
```

### GET /api/records/[id]

업무 기록 단건 조회

```typescript
// Response
{
  record: WorkRecord;
}
```

### POST /api/records/process

원본 텍스트를 LLM으로 구조화하고 Draft 저장

```typescript
// Request
{
  rawContent: string
}

// Response
{
  id: string,
  structured: { ... },
  sensitiveTerms: string[]
}
```

### POST /api/records/confirm

사용자가 검토/수정한 데이터를 최종 저장 + 벡터화

```typescript
// Request
{
  id: string,
  company: string,
  project: string,
  // ... 모든 필드
}

// Response
{
  id: string,
  status: 'CONFIRMED'
}
```

### DELETE /api/records/[id]

업무 기록 삭제

```typescript
// Response
{
  success: boolean;
}
```

### POST /api/chat

RAG 채팅 (stateless, streaming)

```typescript
// Request
{
  message: string;
}

// Response
ReadableStream<string>;
```

## 코딩 컨벤션

### TypeScript

- strict mode 활성화
- `@typescript-eslint/consistent-type-imports` 사용 (`import type`)
- 미사용 변수는 `_` prefix로 명시적 표현
- `interface` 사용 금지, `type`만 사용

### 파일/폴더 네이밍

- 컴포넌트: PascalCase (`InputContainer.tsx`)
- 훅: camelCase with use prefix (`useRecords.ts`)
- 유틸/상수/API: camelCase (`formatDate.ts`, `getRecords.ts`)
- 타입 파일: camelCase (`recordDto.ts`)

### 함수 선언 스타일

**컴포넌트**: 화살표 함수 + 하단에서 export default

```typescript
// features/record/components/RecordCard.tsx
import type { RecordDto } from '../types';

type Props = {
  record: RecordDto;
};

const RecordCard = ({ record }: Props) => {
  return (
    <div>
      <h2>{record.project}</h2>
      <p>{record.summary}</p>
    </div>
  );
};

export default RecordCard;
```

**나머지 (유틸, 훅, API 등)**: export const 화살표 함수

```typescript
// features/record/utils/formatPeriod.ts
export const formatPeriod = (startAt: Date, endAt: Date | null) => {
  const start = startAt.toLocaleDateString('ko-KR');
  const end = endAt ? endAt.toLocaleDateString('ko-KR') : '진행중';
  return `${start} ~ ${end}`;
};
```

```typescript
// features/record/apis/getRecords.ts
import type { WorkRecord } from '@prisma/client';

export const getRecords = async (): Promise<WorkRecord[]> => {
  const response = await fetch('/api/records');
  const data = await response.json();
  return data.records;
};
```

```typescript
// features/record/hooks/queries/useRecords.ts
import { useQuery } from '@tanstack/react-query';
import { getRecords } from '../../apis';

export const useRecords = () => {
  return useQuery({
    queryKey: ['records'],
    queryFn: getRecords,
  });
};
```

### Prisma

- 클라이언트는 `lib/prisma.ts`에서 싱글톤으로 export
- DB 쿼리는 Route Handler에서만 실행 (서버 사이드)
- 복잡한 쿼리는 `features/[domain]/services/`에 함수로 분리

### LLM

- 프롬프트 템플릿은 `features/[domain]/prompts/`에 관리
- 응답 스키마는 Zod로 정의하여 타입 안전성 확보
- API 호출 추상화는 `lib/llm.ts`에서 관리 (모델 교체 용이하게)

## 환경 변수

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/memoir?schema=public"

# LLM (둘 중 하나 또는 둘 다)
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_API_KEY="sk-..."
```

## 개발 명령어

```bash
# 개발 서버
npm run dev

# 빌드
npm run build

# 린트
npm run lint

# Prisma 명령어
npx prisma generate      # schema.prisma → Prisma Client 타입 생성
npx prisma db push       # schema.prisma → DB 스키마 동기화 (개발용, 마이그레이션 없이)
npx prisma migrate dev   # 마이그레이션 생성 + 적용 (운영 전 사용)
npx prisma migrate deploy # 마이그레이션 적용 (운영 배포 시)
npx prisma studio        # DB GUI (localhost:5555)
```

### Prisma 워크플로우

1. `prisma/schema.prisma` 수정
2. `npx prisma generate` 실행 (타입 갱신)
3. 개발 중: `npx prisma db push`로 빠르게 동기화
4. 배포 전: `npx prisma migrate dev`로 마이그레이션 생성
5. 배포 시: `npx prisma migrate deploy`로 마이그레이션 적용

## 인증

- 없음 (private 서비스, 본인만 사용)
- Cloudflare Tunnel + Access로 접근 제어 가능
