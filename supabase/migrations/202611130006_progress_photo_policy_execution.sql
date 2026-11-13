-- The filename parser calls another helper in the private schema.
-- Execute it with its owner's schema access, without granting authenticated users access to the schema.
alter function private.athlete_progress_photo_owner(text) security definer;
