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
| Backend    | RSC + Server Actions (Route Handler 최소화)                  |
| Database   | PostgreSQL + pgvector                                        |
| ORM        | Prisma                                                       |
| Data Fetch | RSC에서 Prisma 직접 호출 + revalidatePath                    |
| AI SDK     | Vercel AI SDK                                                |
| Validation | Zod                                                          |
| LLM        | OpenAI GPT 시리즈 (Vercel AI SDK로 추상화)                   |
| Embedding  | OpenAI text-embedding-3-small                                |
| Infra      | Docker Compose, Cloudflare Tunnel, GitHub Actions CI/CD      |
| Language   | TypeScript 5 (strict mode)                                   |

### 주요 라이브러리

- **Vercel AI SDK**: LLM 호출 추상화, 스트리밍 응답, 구조화된 출력(Structured Output), Server
  Actions 네이티브 통합
- **Prisma**: 타입 안전한 DB 접근, pgvector 지원
- **Zod**: 런타임 스키마 검증 + LLM 응답 파싱
- **shadcn/ui**: 빠른 UI 구축

## 아키텍처

### 배포 구조

```mermaid
---
config:
  layout: elk
---
flowchart LR
    subgraph Next["Next.js"]
        AR["App Router"]
        RSC["Server Component"]
        SA["Server Actions"]
        RH["Route Handler"]
        AISDK["Vercel AI SDK"]
    end
    subgraph Docker["Docker Compose"]
        Next
        DB[("PostgreSQL + pgvector")]
    end
    subgraph Server["Home Server"]
        CT["cloudflared"]
        Docker
    end

    User(("User")) -->|HTTPS| CF["Cloudflare Network"]
    CF -.->|Tunnel| CT
    CT --> AR
    AR --> RSC & SA & RH

    RSC -->|Prisma Query| DB
    SA -->|Prisma Mutation| DB
    RH -->|Vector Search| DB

    SA -.->|revalidatePath| RSC
    SA -->|Structured Output & Embedding| AISDK
    RH -->|Streaming| AISDK
    AISDK -.->|API Call| OpenAI["OpenAI API"]

    style AR fill:#000,stroke:#333,color:#fff
    style RSC fill:#111,stroke:#333,color:#fff
    style SA fill:#222,stroke:#333,color:#fff
    style RH fill:#222,stroke:#333,color:#fff
    style AISDK fill:#333,stroke:#333,color:#fff
    style DB fill:#336791,stroke:#333,color:#fff
    style CT fill:#059,stroke:#333,color:#fff
    style User fill:#666,stroke:#333,color:#fff
    style CF fill:#f60,stroke:#333,color:#fff
    style OpenAI fill:#10a37f,stroke:#333,color:#fff
```

- 홈서버에서 Docker Compose로 운영
- Cloudflare Tunnel로 외부 노출 없이 보안 접속
- GitHub Actions로 CI/CD

### 데이터 플로우

```
[페이지 1: Input]
원본 텍스트 붙여넣기
    ↓ Server Action: processRecordAction()
    ↓ LLM 호출 (구조화 + 민감정보 추출)
    ↓ Draft 상태로 DB 저장
    ↓ redirect → /review/[id]

[페이지 2: Review]
폼에서 검토/수정 (민감정보 하이라이트)
    ↓ Server Action: confirmRecordAction()
    ↓ Embedding 생성
    ↓ pgvector + RDB 저장 (Confirmed 상태)
    ↓ revalidatePath + redirect → /records

[페이지 3: Chat]
RAG 채팅 (stateless, 매번 새 대화)
    ↓ useChat hook → Route Handler: POST /api/chat
    ↓ Query embedding → pgvector 유사도 검색 → LLM 스트리밍 응답

[페이지 4: Records]
업무 기록 테이블 뷰 (노션 스타일)
    ↓ RSC에서 Prisma 직접 호출
```

### 데이터 Fetching 전략 (RSC + Server Actions)

RSC에서 Prisma를 직접 호출하고, 데이터 변경은 Server Actions로 처리. fetch 호출 없이 타입 안전한
데이터 흐름 유지.

| 작업          | 방식                               |
| ------------- | ---------------------------------- |
| 조회          | RSC에서 Prisma 직접 호출           |
| 생성/수정     | Server Action + revalidatePath     |
| 삭제          | Server Action + revalidatePath     |
| Chat 스트리밍 | Route Handler + useChat (ai/react) |

#### RSC 데이터 조회 패턴

```typescript
// app/records/page.tsx (서버 컴포넌트)
import { prisma } from '@/lib/prisma';
import RecordTable from '@/features/record/components/RecordTable';

const RecordsPage = async () => {
  const records = await prisma.workRecord.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: { createdAt: 'desc' },
  });

  return <RecordTable records={records} />;
};

export default RecordsPage;
```

#### Server Action 패턴

```typescript
// features/record/actions/confirmRecordAction.ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { generateEmbedding } from '@/lib/embedding';

export const confirmRecordAction = async (formData: FormData) => {
  const id = formData.get('id') as string;
  const company = formData.get('company') as string;
  // ... 폼 데이터 추출

  // Embedding 생성
  const embedding = await generateEmbedding(`${company} ${project} ${summary}`);

  // DB 저장
  await prisma.workRecord.update({
    where: { id },
    data: {
      company,
      project,
      // ... 나머지 필드
      status: 'CONFIRMED',
    },
  });

  // 벡터 저장 (raw query)
  await prisma.$executeRaw`
    UPDATE "WorkRecord"
    SET embedding = ${embedding}::vector
    WHERE id = ${id}
  `;

  revalidatePath('/records');
  redirect('/records');
};
```

#### Chat 스트리밍 (Route Handler + useChat)

Chat 기능은 `ai/rsc`가 실험적 상태이므로, 안정적인 `ai/react` + Route Handler 조합을 사용한다.

```typescript
// app/api/chat/route.ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { generateEmbedding, searchSimilarRecords } from '@/lib/embedding';

export const POST = async (req: Request) => {
  const { messages } = await req.json();
  const lastMessage = messages[messages.length - 1].content;

  // RAG: 유사 기록 검색
  const queryEmbedding = await generateEmbedding(lastMessage);
  const context = await searchSimilarRecords(queryEmbedding);

  const result = streamText({
    model: openai('gpt-4o'),
    system: `당신은 사용자의 커리어 코치입니다. 다음 맥락을 참고하세요:\n${JSON.stringify(context)}`,
    messages,
  });

  return result.toDataStreamResponse();
};
```

```typescript
// features/chat/components/ChatInterface.tsx
'use client';

import { useChat } from 'ai/react';

const ChatInterface = () => {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>{m.role}: {m.content}</div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  );
};

export default ChatInterface;
```

## 폴더 구조

```
src/
├── app/                          # Next.js App Router
│   ├── input/
│   │   └── page.tsx              # 원본 텍스트 입력 페이지
│   ├── review/
│   │   └── [id]/
│   │       └── page.tsx          # 검토/수정 페이지
│   ├── chat/
│   │   └── page.tsx              # RAG 채팅 페이지
│   ├── records/
│   │   └── page.tsx              # 업무 기록 목록 (RSC에서 Prisma 직접 호출)
│   ├── api/                      # Route Handlers (최소화)
│   │   └── chat/
│   │       └── route.ts          # RAG 채팅 스트리밍 (useChat 연동)
│   ├── layout.tsx
│   ├── page.tsx                  # 랜딩 또는 /input 리다이렉트
│   └── globals.css
│
├── features/                     # 도메인별 로직 (FSD 스타일)
│   ├── record/                   # 업무 기록 도메인
│   │   ├── actions/              # Server Actions
│   │   │   ├── processRecordAction.ts  # 원본 → LLM 구조화
│   │   │   ├── confirmRecordAction.ts  # 최종 저장 + 벡터화
│   │   │   ├── deleteRecordAction.ts   # 기록 삭제
│   │   │   └── index.ts
│   │   ├── components/           # UI 컴포넌트
│   │   ├── services/             # 비즈니스 로직 (서버 사이드)
│   │   │   └── structureRecord.ts
│   │   ├── prompts/              # LLM 프롬프트 템플릿
│   │   ├── schemas/              # Zod 스키마
│   │   ├── types/
│   │   └── utils/
│   └── chat/                     # RAG 채팅 도메인
│       ├── components/           # ChatInterface 등
│       ├── prompts/
│       └── services/
│
├── components/                   # 전역 공용 컴포넌트
│   └── ui/                       # shadcn/ui 컴포넌트
│
├── lib/                          # 인프라 레벨 유틸리티
│   ├── prisma.ts                 # Prisma 클라이언트 싱글톤
│   ├── ai.ts                     # Vercel AI SDK 설정 (모델 인스턴스)
│   ├── embedding.ts              # OpenAI Embedding + pgvector 검색
│   └── utils.ts                  # cn() 등 유틸
│
├── types/                        # 전역 타입 정의
│   └── index.ts
│
└── constants/                    # 전역 상수
    └── index.ts
```

### 폴더 구조 원칙

- **app/**: 라우팅 + RSC 데이터 조회. page.tsx에서 Prisma 직접 호출 가능
- **features/**: 도메인별 로직 캡슐화. feature 간 참조 금지
- **features/\*/actions/**: Server Actions 정의. 데이터 변경 로직 담당
- **components/**: 순수 UI 컴포넌트, 비즈니스 로직 없음
- **lib/**: DB, AI SDK 등 인프라 레벨 코드. 모든 feature에서 참조 가능

### 의존성 방향

```
app → features → lib
        ↓
    components
```

- features는 lib을 참조할 수 있음
- features끼리는 서로 참조하지 않음
- 공통 로직은 lib으로 추출

## 데이터 모델

### WorkRecord 스키마 (초안)

구현 과정에서 변경될 수 있음. 핵심 필드만 정의.

```prisma
model WorkRecord {
  id        String   @id @default(cuid())
  status    Status   @default(DRAFT)   // DRAFT | CONFIRMED

  // 메타데이터
  company     String
  project     String
  startAt     DateTime
  endAt       DateTime?
  techStack   String[]
  tags        String[]

  // 구조화된 콘텐츠
  summary     String    // 한 줄 요약
  problem     String    // 문제 상황 + 해결 과정
  decision    String    // 의사결정 근거
  reflection  String    // 배운점 / 아쉬운점

  // 원본 및 벡터
  rawContent  String
  embedding   Unsupported("vector(1536)")?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### pgvector 유사도 검색

RAG 검색 시 `<=>` 연산자로 코사인 거리 계산.

```typescript
const results = await prisma.$queryRaw`
  SELECT id, summary, problem, decision,
         embedding <=> ${queryEmbedding}::vector AS distance
  FROM "WorkRecord"
  WHERE status = 'CONFIRMED'
  ORDER BY distance
  LIMIT ${limit}
`;
```

## Server Actions 설계

Route Handler 대신 Server Actions를 사용하여 데이터 변경을 처리한다.

### processRecordAction

원본 텍스트를 LLM으로 구조화하고 Draft 저장

```typescript
// features/record/actions/processRecordAction.ts
'use server';

type ProcessRecordInput = {
  rawContent: string;
};

type ProcessRecordOutput = {
  id: string;
  structured: StructuredRecord;
  sensitiveTerms: string[];
};

export const processRecordAction = async (
  input: ProcessRecordInput
): Promise<ProcessRecordOutput> => {
  // LLM 호출 → 구조화 + 민감정보 추출
  // Draft 상태로 DB 저장
  // redirect('/review/[id]') 또는 id 반환
};
```

### confirmRecordAction

사용자가 검토/수정한 데이터를 최종 저장 + 벡터화

```typescript
// features/record/actions/confirmRecordAction.ts
'use server';

export const confirmRecordAction = async (formData: FormData): Promise<void> => {
  // 폼 데이터 파싱 + Zod 검증
  // Embedding 생성
  // DB 저장 (status: CONFIRMED)
  // revalidatePath('/records')
  // redirect('/records')
};
```

### deleteRecordAction

업무 기록 삭제

```typescript
// features/record/actions/deleteRecordAction.ts
'use server';

export const deleteRecordAction = async (id: string): Promise<void> => {
  // DB 삭제
  // revalidatePath('/records')
};
```

### 조회는 RSC에서 직접

목록/단건 조회는 Server Action이 아닌 RSC에서 Prisma를 직접 호출한다.

```typescript
// app/records/page.tsx
const records = await prisma.workRecord.findMany({ ... });

// app/review/[id]/page.tsx
const record = await prisma.workRecord.findUnique({ where: { id } });
```

## 코딩 컨벤션

### TypeScript

- strict mode 활성화
- `@typescript-eslint/consistent-type-imports` 사용 (`import type`)
- 미사용 변수는 `_` prefix로 명시적 표현
- `interface` 사용 금지, `type`만 사용
- `React.ReactNode` 등 React 네임스페이스 절대 사용하지 말 것

### 파일/폴더 네이밍

- 컴포넌트: PascalCase (`RecordCard.tsx`)
- Server Actions: camelCase with Action postfix (`processRecordAction.ts`, `confirmRecordAction.ts`)
- 유틸/상수: camelCase (`formatDate.ts`, `cn.ts`)
- 타입 파일: camelCase (`record.ts`)

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
// features/record/actions/deleteRecordAction.ts
'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';

export const deleteRecordAction = async (id: string) => {
  await prisma.workRecord.delete({ where: { id } });
  revalidatePath('/records');
};
```

### Prisma

- 클라이언트는 `lib/prisma.ts`에서 싱글톤으로 export
- DB 쿼리는 RSC 및 Server Actions에서 실행 (서버 사이드)
- 복잡한 쿼리는 `features/[domain]/services/`에 함수로 분리

### Vercel AI SDK

- 모델 인스턴스는 `lib/ai.ts`에서 관리
- 프롬프트 템플릿은 `features/[domain]/prompts/`에 관리
- 응답 스키마는 Zod로 정의하여 `generateObject`로 타입 안전한 응답 파싱
- Chat 스트리밍은 Route Handler + `useChat` 조합 사용 (ai/react)

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
npm run dev              # 개발 서버
npm run build            # 빌드
npm run lint             # 린트

npx prisma generate      # 스키마 변경 후 타입 생성
npx prisma db push       # 개발 중 DB 동기화
npx prisma studio        # DB GUI
```

## 인증

- 없음 (private 서비스, 본인만 사용)
- Cloudflare Tunnel + Access로 접근 제어 가능

## 참고 자료

- [Vercel AI SDK - RAG Chatbot Guide](https://ai-sdk.dev/cookbook/guides/rag-chatbot)
