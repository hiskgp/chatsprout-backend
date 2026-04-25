import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Create Org - Organization இல்ல Org
  const org = await prisma.org.upsert({
    where: { id: 'demo-org-id' },
    update: {},
    create: {
      id: 'demo-org-id',
      name: 'Demo Organization',
      slug: 'demo-org',
      plan: 'PRO',
      credits: 10000,
      aiEnabled: true,
      systemPrompt: 'You are a helpful WhatsApp assistant for Demo Organization.'
    }
  });
  console.log('✅ Created org:', org.name);

  // 2. Create Users - organizationId இல்ல orgId
  const hashedPassword = await bcrypt.hash('Demo1234', 10);
  
  await prisma.user.upsert({
    where: { email: 'owner@demo.com' },
    update: {},
    create: {
      email: 'owner@demo.com',
      passwordHash: hashedPassword,
      name: 'Demo Owner',
      role: 'OWNER',
      orgId: org.id,
      emailVerified: true
    }
  });

  await prisma.user.upsert({
    where: { email: 'admin@demo.com' },
    update: {},
    create: {
      email: 'admin@demo.com',
      passwordHash: hashedPassword,
      name: 'Demo Admin',
      role: 'ADMIN',
      orgId: org.id,
      emailVerified: true
    }
  });

  await prisma.user.upsert({
    where: { email: 'agent@demo.com' },
    update: {},
    create: {
      email: 'agent@demo.com',
      passwordHash: hashedPassword,
      name: 'Demo Agent',
      role: 'AGENT',
      orgId: org.id,
      emailVerified: true
    }
  });
  console.log('✅ Created users: 3');

  // 3. Create Contacts - waId required, orgId use பண்ணு
  await prisma.contact.upsert({
    where: { 
      id: 'contact-1'
    },
    update: {},
    create: {
      id: 'contact-1',
      orgId: org.id,
      waId: '919876543210',
      phone: '+919876543210',
      name: 'John Doe',
      email: 'john@example.com',
      tags: ['VIP', 'Customer'],
      customFields: {
        company: 'Tech Corp',
        city: 'Chennai'
      }
    }
  });

  await prisma.contact.upsert({
    where: { 
      id: 'contact-2'
    },
    update: {},
    create: {
      id: 'contact-2',
      orgId: org.id,
      waId: '919876543211',
      phone: '+919876543211',
      name: 'Jane Smith',
      email: 'jane@example.com',
      tags: ['Lead'],
      customFields: {
        company: 'Design Co',
        city: 'Bangalore'
      }
    }
  });
  console.log('✅ Created contacts: 2');

  // 4. Create Catalog first - Product க்கு தேவை
  const catalog = await prisma.catalog.upsert({
    where: { metaCatalogId: 'demo-catalog' },
    update: {},
    create: {
      metaCatalogId: 'demo-catalog',
      name: 'Demo Catalog',
      orgId: org.id
    }
  });

  // 5. Create Products - catalogId required, metaProductId required
  await prisma.product.upsert({
    where: { metaProductId: 'prod-premium' },
    update: {},
    create: {
      metaProductId: 'prod-premium',
      name: 'Premium Widget',
      description: 'High-quality widget for enterprise',
      price: 299900,
      currency: 'INR',
      sku: 'WID-PREM-001',
      catalogId: catalog.id,
      orgId: org.id
    }
  });

  await prisma.product.upsert({
    where: { metaProductId: 'prod-basic' },
    update: {},
    create: {
      metaProductId: 'prod-basic',
      name: 'Basic Plan',
      description: 'Monthly subscription',
      price: 49900,
      currency: 'INR',
      sku: 'PLAN-BASIC-001',
      catalogId: catalog.id,
      orgId: org.id
    }
  });
  console.log('✅ Created products: 2');

  // 6. Create Flow - NEW_CHAT trigger use பண்ணு
  await prisma.flow.upsert({
    where: { id: 'welcome-flow' },
    update: {},
    create: {
      id: 'welcome-flow',
      name: 'Welcome Flow',
      description: 'Auto-welcome new contacts',
      orgId: org.id,
      isActive: true,
      trigger: 'NEW_CHAT',
      triggerConfig: {},
      nodes: [
        {
          id: 'node-1',
          type: 'send_message',
          data: {
            message: 'Hi! Welcome to Demo Organization. How can we help you today?'
          }
        }
      ],
      edges: []
    }
  });
  console.log('✅ Created flow: Welcome Flow');

  // 7. Create Template
  await prisma.template.upsert({
    where: { id: 'order-confirm-template' },
    update: {},
    create: {
      id: 'order-confirm-template',
      name: 'order_confirmation',
      category: 'UTILITY',
      language: 'en',
      orgId: org.id,
      status: 'APPROVED',
      body: 'Hi {{1}}, your order #{{2}} for ₹{{3}} is confirmed! Track here: {{4}}',
      buttons: []
    }
  });
  console.log('✅ Created template: order_confirmation');

  console.log('🎉 Seed completed successfully!\n');
  console.log('📧 Demo Credentials:');
  console.log('Owner: owner@demo.com / Demo1234');
  console.log('Admin: admin@demo.com / Demo1234');
  console.log('Agent: agent@demo.com / Demo1234');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });