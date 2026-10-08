async function check() {
  const t0 = Date.now();
  const loginRes = await fetch('https://evalnexa.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@evalnexa.edu', password: 'Admin@1234' }),
  });
  const loginData: any = await loginRes.json();
  const token = loginData?.data?.token;

  const modRes = await fetch('https://evalnexa.onrender.com/api/moderation/6ac534cd75a10db981adc07e', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const modData: any = await modRes.json();
  console.log(`Fetched in ${Date.now() - t0}ms:`);
  console.log('Status:', modData?.data?.status);
  console.log('Total marks:', modData?.data?.totalMarks);
  console.log('Total possible:', modData?.data?.totalPossibleMarks);
  const q7 = modData?.data?.questionMarks?.find((q: any) => q.questionNumber === 7);
  console.log('Q7 marks:', q7?.marks);
}

check().catch(console.error);
