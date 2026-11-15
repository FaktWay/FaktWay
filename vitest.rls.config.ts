import { defineConfig } from 'vitest/config';
import localConfig from './vitest.config';

/** Jawne uruchomienie na osobnej bazie testowej; testy tworzą i usuwają dane. */
export default defineConfig({
  ...localConfig,
  test: {
    ...localConfig.test,
    // Glob zamiast ręcznej listy: każdy nowy `tests/rls-*.test.ts` biegnie w CI
    // „RLS isolation” bez edycji tego pliku (lista była źródłem konfliktów między
    // PR-ami i raz zgubiła test: rls-mobile-wydatki). Strażnik w
    // tests/unit/rls-environment.test.ts pilnuje, żeby test bazy nie leżał poza globem.
    include: ['tests/rls-*.test.ts'],
    exclude: [],
    setupFiles: ['./tests/setup-rls.ts'],
  },
});
