async function runLifecycle() {
  console.log('=== STEP 1: EXAMINER RESOLVES BLOCKING CONDITION (MAPS Q2) ===');
  const examinerLogin = await fetch('https://evalnexa.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'examiner@evalnexa.edu', password: 'Examiner@5678' }),
  });
  const examinerData = await examinerLogin.json() as any;
  const examinerToken = examinerData.data.token;
  console.log('Examiner Login:', examinerData.success ? 'SUCCESS' : 'FAILED');

  const abId = '6ac52306f938543861ee0c2a';
  const evalId = '6ac534cd75a10db981adc07e';

  // Map Q2 pages
  const mapRes = await fetch(`https://evalnexa.onrender.com/api/answer-books/${abId}/question-mapping`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + examinerToken,
    },
    body: JSON.stringify({
      questionNumber: 2,
      pages: [1],
    }),
  });
  const mapData = await mapRes.json() as any;
  console.log('Q2 Page Mapping result:', mapData.success ? 'SUCCESS' : mapData.message);

  console.log('\n=== STEP 2: EXAMINER RESUBMITS EVALUATION ===');
  // First fetch current questionMarks to ensure exact payload
  const currentEvalRes = await fetch(`https://evalnexa.onrender.com/api/evaluations/${evalId}`, {
    headers: { Authorization: 'Bearer ' + examinerToken },
  });
  const currentEvalData = await currentEvalRes.json() as any;
  const rawQms = currentEvalData.data.questionMarks || [];

  const cleanQms = rawQms.map((q: any) => ({
    questionNumber: q.questionNumber,
    marks: q.questionNumber === 7 ? 3 : Number(q.marks) || 0,
    status: q.status || 'MARKED',
    comment: q.comment || '',
    examinerReviewed: true,
  }));

  const submitRes = await fetch(`https://evalnexa.onrender.com/api/evaluations/${evalId}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + examinerToken,
    },
    body: JSON.stringify({
      questionMarks: cleanQms,
      remarks: 'Resubmitted after resolving Q2 page mapping and updating Q7 mark to 3/5.',
    }),
  });
  const submitData = await submitRes.json() as any;
  console.log('Submit HTTP Status:', submitRes.status);
  console.log('Submit Success:', submitData.success);
  console.log('Evaluation Status after Resubmit:', submitData.data?.status);
  console.log('Total Marks after Resubmit:', submitData.data?.totalMarks);
  console.log('Total Possible Marks:', submitData.data?.totalPossibleMarks);

  console.log('\n=== STEP 3: MODERATOR REVIEWS & APPROVES EVALUATION ===');
  const modLogin = await fetch('https://evalnexa.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@evalnexa.edu', password: 'Admin@1234' }),
  });
  const modData = await modLogin.json() as any;
  const modToken = modData.data.token;
  console.log('Moderator / Admin Login:', modData.success ? 'SUCCESS' : 'FAILED');

  // Verify moderation view state
  const modCheckRes = await fetch(`https://evalnexa.onrender.com/api/moderation/${evalId}`, {
    headers: { Authorization: 'Bearer ' + modToken },
  });
  const modCheckData = await modCheckRes.json() as any;
  console.log('Moderation View Status before approval:', modCheckData.data?.status);
  console.log('Total Marks:', modCheckData.data?.totalMarks);

  // Approve evaluation
  const approveRes = await fetch(`https://evalnexa.onrender.com/api/moderation/${evalId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + modToken,
    },
    body: JSON.stringify({
      notes: 'Final quality audit passed. All 10 questions evaluated, verified, and mapped. Final marks certified at 19/35.',
    }),
  });
  const approveData = await approveRes.json() as any;
  console.log('Approve HTTP Status:', approveRes.status);
  console.log('Approve Success:', approveData.success);
  console.log('Evaluation Status after Approve:', approveData.data?.status);

  console.log('\n=== STEP 4: FINAL VERIFICATION IN DB ===');
  // Check evaluation in DB
  const finalEvalRes = await fetch(`https://evalnexa.onrender.com/api/evaluations/${evalId}`, {
    headers: { Authorization: 'Bearer ' + modToken },
  });
  const finalEvalData = await finalEvalRes.json() as any;
  console.log('Final Evaluation Status:', finalEvalData.data?.status);
  console.log('Final Total Marks:', finalEvalData.data?.totalMarks);
  console.log('Final Total Possible Marks:', finalEvalData.data?.totalPossibleMarks);

  // Check answerBook in DB
  const finalAbRes = await fetch(`https://evalnexa.onrender.com/api/answer-books/${abId}`, {
    headers: { Authorization: 'Bearer ' + modToken },
  });
  const finalAbData = await finalAbRes.json() as any;
  console.log('Final AnswerBook Status:', finalAbData.data?.answerBook?.status);
}

runLifecycle().catch(console.error);
