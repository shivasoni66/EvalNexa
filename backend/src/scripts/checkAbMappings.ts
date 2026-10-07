async function checkMappings() {
  const loginRes = await fetch('https://evalnexa.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@evalnexa.edu', password: 'Admin@1234' }),
  });
  const { data: { token } } = await loginRes.json() as any;

  const abRes = await fetch('https://evalnexa.onrender.com/api/answer-books/6ac52306f938543861ee0c2a', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const abData = await abRes.json() as any;
  const ab = abData.data?.answerBook;
  console.log('AnswerBook status:', ab?.status);
  console.log('questionPageMapping:');
  for (const m of (ab?.questionPageMapping || [])) {
    console.log(`Q${m.questionNumber}: pages=[${m.pages?.join(', ')}], verified=${m.verified}, source=${m.source}, needsHumanReview=${m.needsHumanReview}`);
  }
}

checkMappings().catch(console.error);
