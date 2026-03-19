import { NextResponse } from "next/server";

export function okJson<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function errorJson(message: string, status = 400) {
  return NextResponse.json(
    {
      error: message,
    },
    { status },
  );
}
