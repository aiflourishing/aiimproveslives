/* Execute the real migration in PostgreSQL WASM, with a minimal Supabase auth stub. */
const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email_confirmed_at timestamptz, is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
  `);
  await db.exec(readFileSync('supabase/migrations/001_reactions.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/003_neutral_laugh.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/004_highlight_submission_order.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/005_sync_safe_updates.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/006_public_vote_scores.sql','utf8'));
  const a = '00000000-0000-0000-0000-000000000001';
  const b = '00000000-0000-0000-0000-000000000002';
  const u = '10000000-0000-0000-0000-000000000001';
  const v = '10000000-0000-0000-0000-000000000002';
  const unverified = '10000000-0000-0000-0000-000000000003';
  await db.query('insert into auth.users values ($1,now(),false),($2,now(),false),($3,null,false)', [u,v,unverified]);
  // Upgrade a database with existing likes and dislikes without deleting votes.
  await db.query('insert into private.impacts(id) values ($1),($2)', [a,b]);
  await db.query("insert into private.reactions(user_id,impact_id,reaction) values ($1,$2,'improved'),($1,$3,'confused')", [u,a,b]);
  await db.exec(readFileSync('supabase/migrations/007_positive_only_votes.sql','utf8'));
  assert.equal((await db.query('select count(*)::int as count from private.reactions')).rows[0].count,2);
  assert.deepEqual((await db.query('select * from public.ranked_impacts()')).rows.map(row=>row.impact_id),[a,b]);
  await db.exec('delete from private.reactions; delete from private.impacts');
  async function actor(role, uid='') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
    await db.exec(`set role ${role}`);
  }
  async function cooldown() {
    await db.exec('reset role');
    await db.exec("update private.vote_limits set last_vote_at = now() - interval '2 seconds'");
    await actor('authenticated',u);
  }
  const rank = async () => (await db.query('select * from public.ranked_impacts()')).rows.map(r=>r.impact_id);
  await actor('service_role');
  await db.query('select public.sync_github_reactions($1,$2)',[[a,b],'[]']);
  await actor('anon');
  assert.deepEqual(await rank(),[a,b]);
  await assert.rejects(db.query('select * from private.reactions'), /permission denied/);
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[a,'heart']), /permission denied/);
  await assert.rejects(db.query('select public.sync_github_reactions($1,$2)',[[a],'[]']), /permission denied/);
  await actor('authenticated',unverified);
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[a,'heart']), /Verified sign-in/);
  await actor('authenticated',u);
  await assert.rejects(db.query('select * from private.github_reactions'), /permission denied/);
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[a,'invented']), /Invalid reaction/);
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[u,'heart']), /Unknown impact/);
  await db.query('select public.set_reaction($1,$2)',[b,'heart']);
  assert.deepEqual(await rank(),[b,a]);
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[b,null]), /wait a moment/);
  await actor('authenticated',v);
  assert.deepEqual((await db.query('select * from public.my_reactions()')).rows,[]);
  await cooldown();
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[b,'confused']), /Invalid reaction/);
  await db.query('select public.set_reaction($1,$2)',[b,'improved']);
  assert.deepEqual(await rank(),[b,a]);
  assert.equal((await db.query('select * from public.my_reactions()')).rows.length,1);
  await cooldown();
  await db.query('select public.set_reaction($1,$2)',[b,null]);
  assert.deepEqual((await db.query('select * from public.my_reactions()')).rows,[]);
  // Check every GitHub reaction's actual database weight against a zero-score impact.
  for (const [index, reaction] of ['+1','heart','hooray','rocket','eyes','-1','laugh','confused'].entries()) {
    await actor('service_role');
    const rows = [{reaction_id:index+1,impact_id:b,github_user_id:42,reaction,created_at:'2026-01-01T00:00:00Z'}];
    await db.query('select public.sync_github_reactions($1,$2)',[[a,b],JSON.stringify(rows)]);
    await actor('anon');
    assert.deepEqual(await rank(), ['-1','confused','laugh'].includes(reaction)?[a,b]:[b,a]);
  }
  await actor('service_role');
  await db.query('select public.sync_github_reactions($1,$2)',[[a,b],'[]']);
  assert.deepEqual(await rank(),[a,b]);
  // Every neutral GitHub reaction on either side of the tie must leave the order unchanged.
  for (const reaction of ['-1','confused','laugh']) for (const target of [a,b]) {
    await actor('service_role');
    const neutral = [{reaction_id:99,impact_id:target,github_user_id:42,reaction,created_at:'2026-01-01T00:00:00Z'}];
    await db.query('select public.sync_github_reactions($1,$2)',[[a,b],JSON.stringify(neutral)]);
    await actor('anon');
    assert.deepEqual(await rank(),[a,b]);
  }
  // Website and GitHub votes both contribute, even when the person is the same.
  await cooldown();
  await db.query('select public.set_reaction($1,$2)',[b,'heart']);
  await actor('service_role');
  const positive = ['heart','+1'].map((reaction,index)=>({reaction_id:index+20,impact_id:b,github_user_id:42,reaction,created_at:'2026-01-01T00:00:00Z'}));
  await db.query('select public.sync_github_reactions($1,$2)',[[a,b],JSON.stringify(positive)]);
  assert.deepEqual(await rank(),[b,a]);
  await db.query('select public.sync_github_reactions($1,$2)',[[a],'[]']);
  assert.deepEqual(await rank(),[a]);
  await actor('authenticated',u);
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[b,'heart']), /Unknown impact/);
  // Newer submissions win equal scores, while points always take precedence.
  await actor('service_role');
  await db.query('select public.sync_github_reactions($1,$2,$3)', [[a,b], '[]', JSON.stringify({[a]:'2026-01-01T00:00:00Z',[b]:'2026-02-01T00:00:00Z'})]);
  await cooldown();
  await db.query('select public.set_reaction($1,$2)',[b,null]);
  await actor('anon');
  assert.deepEqual(await rank(),[b,a]);
  await actor('service_role');
  await db.query('select public.sync_github_reactions($1,$2)', [[a,b], JSON.stringify([{reaction_id:100,impact_id:a,github_user_id:42,reaction:'heart',created_at:'2026-01-01T00:00:00Z'}])]);
  assert.deepEqual(await rank(),[a,b]);
  await db.query('select public.sync_github_reactions($1,$2)', [[a,b], '[]']);
  assert.deepEqual(await rank(),[b,a]); // Legacy sync cannot erase the submission dates.
  await actor('authenticated',u);
  await assert.rejects(db.query('select public.sync_github_reactions($1,$2,$3)', [[a,b], '[]', '{}']), /permission denied/);
  // Positive-only aggregates suppress <= 5 on the server and expose no voters.
  const scoreRows = count => Array.from({length:count}, (_,index) => ({reaction_id:200+index,impact_id:a,github_user_id:200+index,reaction:'heart',created_at:'2026-01-01T00:00:00Z'}));
  for (const [count, expected] of [[0,null],[5,null],[6,6]]) {
    await actor('service_role');
    await db.query('select public.sync_github_reactions($1,$2)', [[a,b],JSON.stringify(scoreRows(count))]);
    await actor('anon');
    const scores = (await db.query('select * from public.impact_scores()')).rows;
    assert.equal(scores.find(row=>row.impact_id===a).score, expected);
    assert.deepEqual(scores.map(row=>row.impact_id),await rank());
    assert.deepEqual(Object.keys(scores[0]).sort(),['impact_id','score']);
  }
  await actor('service_role');
  const mixed = [...scoreRows(7),{reaction_id:299,impact_id:a,github_user_id:299,reaction:'confused',created_at:'2026-01-01T00:00:00Z'}, {reaction_id:300,impact_id:a,github_user_id:300,reaction:'laugh',created_at:'2026-01-01T00:00:00Z'}, {reaction_id:301,impact_id:a,github_user_id:301,reaction:'-1',created_at:'2026-01-01T00:00:00Z'}];
  await db.query('select public.sync_github_reactions($1,$2)',[[a,b],JSON.stringify(mixed)]);
  await cooldown();
  await assert.rejects(db.query('select public.set_reaction($1,$2)',[a,'confused']), /Invalid reaction/);
  // Historical website dislikes and imported negatives cannot cancel out likes.
  await db.exec('reset role');
  await db.query("insert into private.reactions(user_id,impact_id,reaction) values ($1,$2,'confused')",[v,a]);
  assert.equal((await db.query('select * from public.impact_scores()')).rows.find(row=>row.impact_id===a).score,7);
  await cooldown();
  await db.query('select public.set_reaction($1,$2)',[a,'heart']);
  assert.equal((await db.query('select * from public.impact_scores()')).rows.find(row=>row.impact_id===a).score,8);
  await cooldown();
  await db.query('select public.set_reaction($1,$2)',[a,null]);
  assert.equal((await db.query('select * from public.impact_scores()')).rows.find(row=>row.impact_id===a).score,7);
  await db.exec('reset role');
  await db.exec(readFileSync('supabase/migrations/011_ranking_tie_groups.sql','utf8'));
  await db.exec('reset role; delete from private.reactions; delete from private.github_reactions');
  await actor('service_role');
  await db.query('select public.sync_github_reactions($1,$2)', [[a,b], JSON.stringify(scoreRows(1))]);
  await actor('anon');
  let groups = (await db.query('select * from public.impact_ranking()')).rows;
  assert.deepEqual(groups.map(row => row.impact_id), [a,b]);
  assert.deepEqual(groups.map(row => Number(row.vote_rank)), [1,2]);
  assert.ok(groups.every(row => row.score === null));
  await actor('service_role');
  await db.query('select public.sync_github_reactions($1,$2)', [[a,b], '[]']);
  await actor('anon');
  groups = (await db.query('select * from public.impact_ranking()')).rows;
  assert.ok(groups.every(row => Number(row.vote_rank) === 1));
  await db.close();
  console.log('Database checks passed: private rows, verified auth, write restrictions, rate limit, replacement/removal, all eight GitHub weights, combined score, snapshot removal.');
})().catch(error=>{console.error(error);process.exitCode=1;});
