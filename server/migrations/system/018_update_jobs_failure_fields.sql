-- Машиночитаемая причина сбоя задания обновления (задача 4f6c972a, ADR
-- daab6ac4 §4). `error` остаётся английским диагностическим текстом; клиент
-- строит пользовательский текст по `reason` и параметрам (`exit_code`,
-- `failed_stage`, `log_path`) и не разбирает `error`.
--
--   * reason       — значение UpdateJobFailureReason (`installer-hash`,
--     `not-a-service`, `interrupted`, …); NULL у заданий до этой миграции и у
--     успешных (`done`);
--   * failed_stage — этап, на котором задание остановилось (`interrupted` —
--     последний записанный этап до перезапуска процесса);
--   * exit_code    — код возврата установщика (`installer-exit`);
--   * log_path     — путь к журналу установщика, если установщик его оставил.
--
-- Все четыре поля аддитивны и NULL-able: старые строки читаются как «причина
-- неизвестна», клиент для них показывает `error` как фолбэк.
ALTER TABLE update_jobs ADD COLUMN reason TEXT;
ALTER TABLE update_jobs ADD COLUMN failed_stage TEXT;
ALTER TABLE update_jobs ADD COLUMN exit_code INTEGER;
ALTER TABLE update_jobs ADD COLUMN log_path TEXT;
